import {
  ERR_ACCESS_DENIED_BLOCK_DETECTED,
  ERR_EXTERNAL_SERVER_UNREACHABLE,
  ERR_SCRAPER_EMPTY_CONTENT,
  ERR_SCRAPING_TIMEOUT_EXCEEDED,
  WebScraperRunner,
  classifyNavigationError,
} from './web-scraper.runner';

import type { BrowserPoolService } from './browser-pool.service';
import type { ScrapeOptions } from './web-scraper.runner';

const TARGET_URL = 'https://diario.example/nota-de-prensa';

/** Prosa suficiente para que Readability puntue el bloque como articulo. */
const FILLER = [
  'La delegacion municipal presento esta manana el plan de actuacion previsto',
  'para el proximo ejercicio, que contempla una inversion repartida entre las',
  'distintas areas de servicio y un calendario de ejecucion por fases.',
].join(' ');

const ARTICLE_HTML =
  `<!DOCTYPE html><html lang="es"><head><title>Titular de la nota</title></head>` +
  `<body><article><h1>Titular de la nota</h1><p>${FILLER}</p><p>${FILLER}</p></article></body></html>`;

const DEFAULT_OPTIONS: ScrapeOptions = {
  timeoutMs: 20_000,
  maxRetries: 2,
  retryDelayMs: 2_000,
};

/** Superficie de `Page` que el runner usa realmente. */
interface PageMock {
  goto: jest.Mock;
  waitForLoadState: jest.Mock;
  content: jest.Mock;
  url: jest.Mock;
  title: jest.Mock;
  $: jest.Mock;
}

const createPage = (overrides: Partial<PageMock> = {}): PageMock => ({
  goto: jest.fn().mockResolvedValue({ status: () => 200 }),
  waitForLoadState: jest.fn().mockResolvedValue(undefined),
  content: jest.fn().mockResolvedValue(ARTICLE_HTML),
  url: jest.fn().mockReturnValue(TARGET_URL),
  title: jest.fn().mockResolvedValue('Titular de la nota'),
  // `null` = ningun selector de bloqueo presente, que es el caso sano.
  $: jest.fn().mockResolvedValue(null),
  ...overrides,
});

/**
 * Doble del pool. El runner solo conoce `createContext()`, asi que no hace falta
 * `jest.mock('playwright')` ni un navegador real.
 */
const createHarness = (
  page: PageMock,
): {
  runner: WebScraperRunner;
  pool: { createContext: jest.Mock };
  closeContext: jest.Mock;
} => {
  const closeContext = jest.fn().mockResolvedValue(undefined);
  const pool = {
    createContext: jest.fn().mockResolvedValue({
      newPage: jest.fn().mockResolvedValue(page),
      close: closeContext,
    }),
  };

  const runner = new WebScraperRunner(pool as unknown as BrowserPoolService);

  // La espera entre reintentos se neutraliza: las pruebas comprueban CUANTOS
  // intentos hubo, no cuanto se durmio entre ellos.
  jest
    .spyOn(
      runner as unknown as { sleep: (ms: number) => Promise<void> },
      'sleep',
    )
    .mockResolvedValue(undefined);
  jest.spyOn(runner['logger'], 'warn').mockImplementation(() => undefined);

  return { runner, pool, closeContext };
};

const run = async (
  runner: WebScraperRunner,
  options: Partial<ScrapeOptions> = {},
): ReturnType<WebScraperRunner['run']> =>
  runner.run(new URL(TARGET_URL), { ...DEFAULT_OPTIONS, ...options });

/** Error de Playwright por vencimiento, reproducible sin cargar su runtime. */
const timeoutError = (): Error =>
  Object.assign(new Error('page.goto: Timeout 20000ms exceeded.'), {
    name: 'TimeoutError',
  });

const netError = (code: string): Error =>
  new Error(`page.goto: net::${code} at ${TARGET_URL}`);

describe('WebScraperRunner', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('1. Bucle de reintentos', () => {
    it('1.1 deberia reintentar hasta maxRetries y devolver el ultimo fallo', async () => {
      // 1. Arrange
      const page = createPage({
        goto: jest.fn().mockRejectedValue(timeoutError()),
      });
      const { runner } = createHarness(page);

      // 2. Act
      const outcome = await run(runner, { maxRetries: 2 });

      // 3. Assert: tres navegaciones, el primer intento mas los dos reintentos.
      expect(page.goto).toHaveBeenCalledTimes(3);
      expect(outcome.success).toBe(false);
      expect(outcome.success ? null : outcome.code).toBe(
        ERR_SCRAPING_TIMEOUT_EXCEEDED,
      );
      expect(outcome.attempts).toBe(3);
    });

    it('1.2 deberia devolver el articulo si un reintento tiene exito', async () => {
      // 1. Arrange
      const page = createPage({
        goto: jest
          .fn()
          .mockRejectedValueOnce(netError('ERR_CONNECTION_RESET'))
          .mockResolvedValue({ status: () => 200 }),
      });
      const { runner } = createHarness(page);

      // 2. Act
      const outcome = await run(runner);

      // 3. Assert
      expect(page.goto).toHaveBeenCalledTimes(2);
      expect(outcome.success).toBe(true);
      expect(outcome.attempts).toBe(2);
    });

    it('1.3 deberia navegar una sola vez con maxRetries en cero', async () => {
      // 1. Arrange
      const page = createPage({
        goto: jest.fn().mockRejectedValue(timeoutError()),
      });
      const { runner } = createHarness(page);

      // 2. Act
      const outcome = await run(runner, { maxRetries: 0 });

      // 3. Assert
      expect(page.goto).toHaveBeenCalledTimes(1);
      expect(outcome.success).toBe(false);
    });

    it('1.4 deberia reutilizar un unico contexto de navegador entre reintentos', async () => {
      // 1. Arrange
      const page = createPage({
        goto: jest.fn().mockRejectedValue(timeoutError()),
      });
      const { runner, pool } = createHarness(page);

      // 2. Act
      await run(runner, { maxRetries: 3 });

      // 3. Assert: crear un contexto es lo caro, y el aislamiento que aporta es
      //    frente a OTRAS ejecuciones, no frente al intento anterior.
      expect(pool.createContext).toHaveBeenCalledTimes(1);
    });

    it('1.5 deberia usar domcontentloaded y no networkidle al navegar', async () => {
      // 1. Arrange
      const page = createPage();
      const { runner } = createHarness(page);

      // 2. Act
      await run(runner);

      // 3. Assert: con `networkidle` una pagina con analitica o anuncios nunca
      //    alcanza los 500 ms sin peticiones y `goto` venceria sobre un
      //    documento que cargo bien, gastando ademas todos los reintentos.
      expect(page.goto).toHaveBeenCalledWith(TARGET_URL, {
        timeout: 20_000,
        waitUntil: 'domcontentloaded',
      });
    });
  });

  describe('2. Deteccion de bloqueo', () => {
    it('2.1 deberia detectar un campo de contrasena sin reintentar', async () => {
      // 1. Arrange
      const page = createPage({ $: jest.fn().mockResolvedValue({}) });
      const { runner } = createHarness(page);

      // 2. Act
      const outcome = await run(runner, { maxRetries: 3 });

      // 3. Assert: un muro no se cae por insistir; reintentar solo gastaria otro
      //    timeout y reforzaria el limite de tasa del portal.
      expect(outcome.success ? null : outcome.code).toBe(
        ERR_ACCESS_DENIED_BLOCK_DETECTED,
      );
      expect(page.goto).toHaveBeenCalledTimes(1);
    });

    it('2.2 deberia detectar una redireccion a una pagina de acceso', async () => {
      // 1. Arrange
      const page = createPage({
        url: jest
          .fn()
          .mockReturnValue('https://diario.example/login?next=/nota'),
      });
      const { runner } = createHarness(page);

      // 2. Act
      const outcome = await run(runner);

      // 3. Assert
      expect(outcome.success ? null : outcome.code).toBe(
        ERR_ACCESS_DENIED_BLOCK_DETECTED,
      );
    });

    it('2.3 deberia detectar un estado HTTP de bloqueo', async () => {
      // 1. Arrange
      const page = createPage({
        goto: jest.fn().mockResolvedValue({ status: () => 403 }),
      });
      const { runner } = createHarness(page);

      // 2. Act
      const outcome = await run(runner);

      // 3. Assert
      expect(outcome.success ? null : outcome.code).toBe(
        ERR_ACCESS_DENIED_BLOCK_DETECTED,
      );
      expect(outcome.success ? '' : outcome.message).toContain('403');
    });

    it('2.4 deberia detectar el intersticial anti-bot por su titulo', async () => {
      // 1. Arrange
      const page = createPage({
        title: jest.fn().mockResolvedValue('Just a moment...'),
      });
      const { runner } = createHarness(page);

      // 2. Act
      const outcome = await run(runner);

      // 3. Assert
      expect(outcome.success ? null : outcome.code).toBe(
        ERR_ACCESS_DENIED_BLOCK_DETECTED,
      );
    });

    it('2.5 no deberia bloquear un dominio por llevar "login" en el host', async () => {
      // 1. Arrange
      const page = createPage({
        url: jest.fn().mockReturnValue('https://loginformativo.example/nota'),
      });
      const { runner } = createHarness(page);

      // 2. Act
      const outcome = await run(runner);

      // 3. Assert: los patrones se evaluan sobre la ruta y la query, nunca sobre
      //    el host, para no juzgar un dominio por su nombre.
      expect(outcome.success).toBe(true);
    });
  });

  describe('3. Clasificacion de errores de red', () => {
    it('3.1 deberia clasificar el vencimiento de Playwright como timeout', () => {
      // 1. Arrange, 2. Act & 3. Assert
      expect(classifyNavigationError(timeoutError())).toBe(
        ERR_SCRAPING_TIMEOUT_EXCEEDED,
      );
    });

    it('3.2 deberia clasificar net::ERR_TIMED_OUT como timeout', () => {
      // 1. Arrange, 2. Act & 3. Assert: no es un `TimeoutError` de Playwright
      //    —lo declara la pila de red de Chromium— pero semanticamente lo es.
      expect(classifyNavigationError(netError('ERR_TIMED_OUT'))).toBe(
        ERR_SCRAPING_TIMEOUT_EXCEEDED,
      );
    });

    it('3.3 deberia clasificar un fallo de DNS como servidor inalcanzable', () => {
      // 1. Arrange, 2. Act & 3. Assert
      expect(classifyNavigationError(netError('ERR_NAME_NOT_RESOLVED'))).toBe(
        ERR_EXTERNAL_SERVER_UNREACHABLE,
      );
    });

    it('3.4 deberia clasificar lo no identificado como servidor inalcanzable', () => {
      // 1. Arrange, 2. Act & 3. Assert: un fallo de navegacion sin clasificar
      //    es, para el operador, un destino al que no se llego.
      expect(classifyNavigationError(new Error('algo raro'))).toBe(
        ERR_EXTERNAL_SERVER_UNREACHABLE,
      );
    });
  });

  describe('4. Extraccion del articulo', () => {
    it('4.1 deberia devolver el articulo y la URL final', async () => {
      // 1. Arrange
      const finalUrl = 'https://diario.example/2026/nota-ampliada';
      const page = createPage({ url: jest.fn().mockReturnValue(finalUrl) });
      const { runner } = createHarness(page);

      // 2. Act
      const outcome = await run(runner);

      // 3. Assert
      expect(outcome.success).toBe(true);
      expect(outcome.success ? outcome.sourceUrl : '').toBe(finalUrl);
      expect(outcome.success ? outcome.article.title : '').toBe(
        'Titular de la nota',
      );
    });

    it('4.2 deberia distinguir "pagina sin articulo" de "servidor caido"', async () => {
      // 1. Arrange
      const page = createPage({
        content: jest
          .fn()
          .mockResolvedValue('<html><body><p>Hola.</p></body></html>'),
      });
      const { runner } = createHarness(page);

      // 2. Act
      const outcome = await run(runner);

      // 3. Assert: el servidor respondio perfectamente. Confundir este caso con
      //    ERR_EXTERNAL_SERVER_UNREACHABLE mandaria al operador a revisar la red
      //    cuando lo que pasa es que la URL no apunta a un articulo.
      expect(outcome.success ? null : outcome.code).toBe(
        ERR_SCRAPER_EMPTY_CONTENT,
      );
    });

    it('4.3 deberia encadenar los avisos de extraccion al hook del llamante', async () => {
      // 1. Arrange: es lo que permite que el banco de pruebas del asistente
      //    muestre lo que en la ejecucion real solo llega al archivo `.log`.
      const page = createPage({
        content: jest
          .fn()
          .mockResolvedValue('<html><body><p>Hola.</p></body></html>'),
      });
      const { runner } = createHarness(page);
      const onContentTooShort = jest.fn();

      // 2. Act
      await runner.run(new URL(TARGET_URL), DEFAULT_OPTIONS, {
        onContentTooShort,
      });

      // 3. Assert
      expect(onContentTooShort).toHaveBeenCalledTimes(1);
    });
  });

  describe('5. Liberacion de recursos', () => {
    it('5.1 deberia cerrar el contexto tras una extraccion con exito', async () => {
      // 1. Arrange
      const { runner, closeContext } = createHarness(createPage());

      // 2. Act
      await run(runner);

      // 3. Assert
      expect(closeContext).toHaveBeenCalledTimes(1);
    });

    it('5.2 deberia cerrar el contexto tambien cuando la navegacion falla', async () => {
      // 1. Arrange
      const page = createPage({
        goto: jest.fn().mockRejectedValue(timeoutError()),
      });
      const { runner, closeContext } = createHarness(page);

      // 2. Act
      await run(runner, { maxRetries: 0 });

      // 3. Assert: es el `finally`. Un contexto sin cerrar retiene su cache en
      //    la memoria del proceso de Chromium, que es residente: la fuga no se
      //    ve en el heap de Node y solo aparece como crecimiento del contenedor.
      expect(closeContext).toHaveBeenCalledTimes(1);
    });

    it('5.3 no deberia lanzar si el pool falla al crear el contexto', async () => {
      // 1. Arrange
      const runner = new WebScraperRunner({
        createContext: jest.fn().mockRejectedValue(new Error('Chromium caido')),
      } as unknown as BrowserPoolService);

      // 2. Act
      const outcome = await run(runner);

      // 3. Assert: ninguna excepcion sale del runner; el motor normalizaria
      //    cualquier fuga a URGENTE, que nunca se reintenta.
      expect(outcome.success).toBe(false);
      expect(outcome.attempts).toBe(0);
    });

    it('5.4 no deberia enmascarar el resultado si el cierre falla', async () => {
      // 1. Arrange
      const page = createPage();
      const runner = new WebScraperRunner({
        createContext: jest.fn().mockResolvedValue({
          newPage: jest.fn().mockResolvedValue(page),
          close: jest.fn().mockRejectedValue(new Error('ya estaba cerrado')),
        }),
      } as unknown as BrowserPoolService);
      jest.spyOn(runner['logger'], 'warn').mockImplementation(() => undefined);

      // 2. Act
      const outcome = await run(runner);

      // 3. Assert: si el `finally` lanzara, sustituiria un exito ya decidido por
      //    una excepcion sobre la limpieza.
      expect(outcome.success).toBe(true);
    });
  });
});
