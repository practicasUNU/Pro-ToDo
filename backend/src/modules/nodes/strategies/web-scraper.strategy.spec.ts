import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { createMockStatePayloadContext } from '@test/factories/state-payload-context.factory';

import {
  ERR_ACCESS_DENIED_BLOCK_DETECTED,
  ERR_EXTERNAL_SERVER_UNREACHABLE,
  ERR_SCRAPER_CONFIG,
  ERR_SCRAPER_EMPTY_CONTENT,
  ERR_SCRAPER_URL_MALFORMED,
  ERR_SCRAPER_URL_UNRESOLVED,
  ERR_SCRAPING_TIMEOUT_EXCEEDED,
  WebScraperStrategy,
  classifyNavigationError,
} from './web-scraper.strategy';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type { BrowserPoolService } from '@modules/nodes/services/browser-pool.service';

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

/** Superficie de `Page` que la estrategia usa realmente. */
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
 * Doble del pool. La estrategia solo conoce `createContext()`, asi que no hace
 * falta `jest.mock('playwright')` ni un navegador real: el aislamiento del
 * contrato es justo lo que permite probar el nodo sin Chromium.
 */
const createHarness = (
  page: PageMock,
): {
  strategy: WebScraperStrategy;
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

  const strategy = new WebScraperStrategy(
    pool as unknown as BrowserPoolService,
  );

  // La espera entre reintentos se neutraliza: las pruebas comprueban CUANTOS
  // intentos hubo, no cuanto se durmio entre ellos.
  jest
    .spyOn(
      strategy as unknown as { sleep: (ms: number) => Promise<void> },
      'sleep',
    )
    .mockResolvedValue(undefined);

  // El nodo avisa de cada reintento por consola; silenciarlo mantiene legible la
  // salida de la suite.
  jest.spyOn(strategy['logger'], 'warn').mockImplementation(() => undefined);

  return { strategy, pool, closeContext };
};

const buildContext = (
  namespaces: Record<string, Record<string, unknown>> = {},
): StatePayloadContext =>
  createMockStatePayloadContext({ currentStep: 'extractor_web', namespaces });

/** Error de Playwright por vencimiento, reproducible sin cargar su runtime. */
const timeoutError = (): Error =>
  Object.assign(new Error('page.goto: Timeout 20000ms exceeded.'), {
    name: 'TimeoutError',
  });

const netError = (code: string): Error =>
  new Error(`page.goto: net::${code} at ${TARGET_URL}`);

describe('WebScraperStrategy', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('0. Identidad del nodo', () => {
    it('0.1 deberia declararse como el nodo EXTRACTOR_WEB', () => {
      // 1. Arrange & 2. Act
      const { strategy } = createHarness(createPage());

      // 3. Assert: la factoria indexa por este valor.
      expect(strategy.nodeType).toBe(NodeType.EXTRACTOR_WEB);
    });
  });

  describe('1. Validacion de configuracion', () => {
    it('1.1 deberia fallar como GRAVE si falta targetUrl', async () => {
      // 1. Arrange
      const { strategy } = createHarness(createPage());

      // 2. Act
      const result = await strategy.execute(buildContext(), {});

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_SCRAPER_CONFIG);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.missingFields).toContain('targetUrl');
    });

    it('1.2 deberia rechazar un timeoutMs por debajo del suelo', async () => {
      // 1. Arrange
      const { strategy } = createHarness(createPage());

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
        timeoutMs: 100,
      });

      // 3. Assert
      expect(result.error?.code).toBe(ERR_SCRAPER_CONFIG);
      expect(result.error?.missingFields).toContain('timeoutMs');
    });

    it('1.3 deberia rechazar claves no declaradas en el DTO', async () => {
      // 1. Arrange
      const { strategy } = createHarness(createPage());

      // 2. Act: `forbidNonWhitelisted` evita que un "selecctor" mal escrito se
      //    ignore en silencio y el nodo corra con una configuracion que nadie pidio.
      const result = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
        selector: 'article',
      });

      // 3. Assert
      expect(result.error?.code).toBe(ERR_SCRAPER_CONFIG);
    });
  });

  describe('2. Resolucion de la URL', () => {
    it('2.1 deberia interpolar targetUrl contra el contexto', async () => {
      // 1. Arrange: es el caso real del pipeline, con el enlace que publica
      //    PARSER_PRE_IA en `parsed_email.extracted_urls`.
      const page = createPage();
      const { strategy } = createHarness(page);
      const context = buildContext({
        parsed_email: { extracted_urls: [TARGET_URL] },
      });

      // 2. Act
      const result = await strategy.execute(context, {
        targetUrl: '{{parsed_email.extracted_urls[0]}}',
      });

      // 3. Assert
      expect(result.success).toBe(true);
      expect(page.goto).toHaveBeenCalledWith(TARGET_URL, expect.anything());
    });

    it('2.2 deberia fallar como GRAVE si la variable no existe en el contexto', async () => {
      // 1. Arrange
      const { strategy } = createHarness(createPage());

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        targetUrl: '{{parsed_email.extracted_urls[0]}}',
      });

      // 3. Assert: `getInterpolatedValue` LANZA, y dejar salir la excepcion la
      //    normalizaria el motor a URGENTE, que `canRetry` nunca reintenta.
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_SCRAPER_URL_UNRESOLVED);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.missingFields).toEqual([
        'parsed_email.extracted_urls[0]',
      ]);
    });

    it('2.3 deberia rechazar una cadena que no es una URL', async () => {
      // 1. Arrange
      const { strategy } = createHarness(createPage());

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        targetUrl: 'no-es-una-url',
      });

      // 3. Assert
      expect(result.error?.code).toBe(ERR_SCRAPER_URL_MALFORMED);
    });

    it('2.4 deberia rechazar un esquema distinto de http o https', async () => {
      // 1. Arrange
      const page = createPage();
      const { strategy } = createHarness(page);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        targetUrl: 'file:///etc/passwd',
      });

      // 3. Assert: la URL viene interpolada de un correo EXTERNO; sin la lista
      //    blanca de esquemas, un `file:` seria una lectura arbitraria del disco
      //    del servidor disparada desde fuera.
      expect(result.error?.code).toBe(ERR_SCRAPER_URL_MALFORMED);
      expect(page.goto).not.toHaveBeenCalled();
    });
  });

  describe('3. Bucle de reintentos', () => {
    it('3.1 deberia reintentar hasta maxRetries y devolver el ultimo fallo', async () => {
      // 1. Arrange
      const page = createPage({
        goto: jest.fn().mockRejectedValue(timeoutError()),
      });
      const { strategy } = createHarness(page);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
        maxRetries: 2,
      });

      // 3. Assert: tres navegaciones, el primer intento mas los dos reintentos.
      expect(page.goto).toHaveBeenCalledTimes(3);
      expect(result.error?.code).toBe(ERR_SCRAPING_TIMEOUT_EXCEEDED);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.stackTrace).toBeDefined();
    });

    it('3.2 deberia devolver el articulo si un reintento tiene exito', async () => {
      // 1. Arrange
      const page = createPage({
        goto: jest
          .fn()
          .mockRejectedValueOnce(netError('ERR_CONNECTION_RESET'))
          .mockResolvedValue({ status: () => 200 }),
      });
      const { strategy } = createHarness(page);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
      });

      // 3. Assert
      expect(page.goto).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
    });

    it('3.3 deberia navegar una sola vez con maxRetries en cero', async () => {
      // 1. Arrange
      const page = createPage({
        goto: jest.fn().mockRejectedValue(timeoutError()),
      });
      const { strategy } = createHarness(page);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
        maxRetries: 0,
      });

      // 3. Assert
      expect(page.goto).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
    });

    it('3.4 deberia reutilizar un unico contexto de navegador entre reintentos', async () => {
      // 1. Arrange
      const page = createPage({
        goto: jest.fn().mockRejectedValue(timeoutError()),
      });
      const { strategy, pool } = createHarness(page);

      // 2. Act
      await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
        maxRetries: 3,
      });

      // 3. Assert: crear un contexto es lo caro, y el aislamiento que aporta es
      //    frente a OTRAS ejecuciones, no frente al intento anterior.
      expect(pool.createContext).toHaveBeenCalledTimes(1);
    });

    it('3.5 deberia usar domcontentloaded y no networkidle al navegar', async () => {
      // 1. Arrange
      const page = createPage();
      const { strategy } = createHarness(page);

      // 2. Act
      await strategy.execute(buildContext(), { targetUrl: TARGET_URL });

      // 3. Assert: con `networkidle` una pagina con analitica o anuncios nunca
      //    alcanza los 500 ms sin peticiones y `goto` venceria sobre un
      //    documento que cargo bien, gastando ademas todos los reintentos.
      expect(page.goto).toHaveBeenCalledWith(TARGET_URL, {
        timeout: 20_000,
        waitUntil: 'domcontentloaded',
      });
    });
  });

  describe('4. Deteccion de bloqueo', () => {
    it('4.1 deberia detectar un campo de contrasena sin reintentar', async () => {
      // 1. Arrange
      const page = createPage({ $: jest.fn().mockResolvedValue({}) });
      const { strategy } = createHarness(page);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
        maxRetries: 3,
      });

      // 3. Assert: un muro no se cae por insistir; reintentar solo gastaria otro
      //    timeout y reforzaria el limite de tasa del portal.
      expect(result.error?.code).toBe(ERR_ACCESS_DENIED_BLOCK_DETECTED);
      expect(page.goto).toHaveBeenCalledTimes(1);
    });

    it('4.2 deberia detectar una redireccion a una pagina de acceso', async () => {
      // 1. Arrange
      const page = createPage({
        url: jest
          .fn()
          .mockReturnValue('https://diario.example/login?next=/nota'),
      });
      const { strategy } = createHarness(page);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
      });

      // 3. Assert
      expect(result.error?.code).toBe(ERR_ACCESS_DENIED_BLOCK_DETECTED);
    });

    it('4.3 deberia detectar un estado HTTP de bloqueo', async () => {
      // 1. Arrange
      const page = createPage({
        goto: jest.fn().mockResolvedValue({ status: () => 403 }),
      });
      const { strategy } = createHarness(page);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
      });

      // 3. Assert
      expect(result.error?.code).toBe(ERR_ACCESS_DENIED_BLOCK_DETECTED);
      expect(result.error?.message).toContain('403');
    });

    it('4.4 deberia detectar el intersticial anti-bot por su titulo', async () => {
      // 1. Arrange
      const page = createPage({
        title: jest.fn().mockResolvedValue('Just a moment...'),
      });
      const { strategy } = createHarness(page);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
      });

      // 3. Assert
      expect(result.error?.code).toBe(ERR_ACCESS_DENIED_BLOCK_DETECTED);
    });

    it('4.5 no deberia bloquear un dominio por llevar "login" en el host', async () => {
      // 1. Arrange
      const page = createPage({
        url: jest.fn().mockReturnValue('https://loginformativo.example/nota'),
      });
      const { strategy } = createHarness(page);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
      });

      // 3. Assert: los patrones se evaluan sobre la ruta y la query, nunca sobre
      //    el host, para no juzgar un dominio por su nombre.
      expect(result.success).toBe(true);
    });
  });

  describe('5. Clasificacion de errores de red', () => {
    it('5.1 deberia clasificar el vencimiento de Playwright como timeout', () => {
      // 1. Arrange, 2. Act & 3. Assert
      expect(classifyNavigationError(timeoutError())).toBe(
        ERR_SCRAPING_TIMEOUT_EXCEEDED,
      );
    });

    it('5.2 deberia clasificar net::ERR_TIMED_OUT como timeout', () => {
      // 1. Arrange, 2. Act & 3. Assert: no es un `TimeoutError` de Playwright
      //    —lo declara la pila de red de Chromium— pero semanticamente lo es.
      expect(classifyNavigationError(netError('ERR_TIMED_OUT'))).toBe(
        ERR_SCRAPING_TIMEOUT_EXCEEDED,
      );
    });

    it('5.3 deberia clasificar un fallo de DNS como servidor inalcanzable', () => {
      // 1. Arrange, 2. Act & 3. Assert
      expect(classifyNavigationError(netError('ERR_NAME_NOT_RESOLVED'))).toBe(
        ERR_EXTERNAL_SERVER_UNREACHABLE,
      );
    });

    it('5.4 deberia clasificar lo no identificado como servidor inalcanzable', () => {
      // 1. Arrange, 2. Act & 3. Assert: un fallo de navegacion sin clasificar
      //    es, para el operador, un destino al que no se llego.
      expect(classifyNavigationError(new Error('algo raro'))).toBe(
        ERR_EXTERNAL_SERVER_UNREACHABLE,
      );
    });
  });

  describe('6. Payload publicado', () => {
    it('6.1 deberia publicar el esquema completo de scraped_web', async () => {
      // 1. Arrange
      const { strategy } = createHarness(createPage());

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
      });

      // 3. Assert: se comprueban las claves y luego cada valor, en vez de un
      //    `toEqual` con `expect.any`, que devuelve `any` y el lint rechaza.
      expect(Object.keys(result.data ?? {}).sort()).toEqual([
        'article_title',
        'byline',
        'full_article_content',
        'scraped_at',
        'source_url',
      ]);
      expect(result.data?.source_url).toBe(TARGET_URL);
      expect(result.data?.article_title).toBe('Titular de la nota');
      expect(typeof result.data?.scraped_at).toBe('string');
      expect(result.data?.byline).toBeNull();
    });

    it('6.2 deberia publicar la URL FINAL tras las redirecciones', async () => {
      // 1. Arrange
      const finalUrl = 'https://diario.example/2026/nota-de-prensa-ampliada';
      const page = createPage({ url: jest.fn().mockReturnValue(finalUrl) });
      const { strategy } = createHarness(page);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
      });

      // 3. Assert
      expect(result.data?.source_url).toBe(finalUrl);
    });

    it('6.3 deberia entregar el contenido como texto plano con saltos', async () => {
      // 1. Arrange
      const { strategy } = createHarness(createPage());

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
      });

      // 3. Assert: es lo que consume el prompt del PROCESADOR_IA; cada etiqueta
      //    que sobreviviera hasta aqui se pagaria en tokens del modelo.
      const content = result.data?.full_article_content;
      expect(typeof content).toBe('string');
      expect(content as string).not.toMatch(/<[a-z/]/i);
      expect(content as string).toContain('\n');
    });

    it('6.4 deberia distinguir "pagina sin articulo" de "servidor caido"', async () => {
      // 1. Arrange
      const page = createPage({
        content: jest
          .fn()
          .mockResolvedValue('<html><body><p>Hola.</p></body></html>'),
      });
      const { strategy } = createHarness(page);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
      });

      // 3. Assert: el servidor respondio perfectamente. Confundir este caso con
      //    ERR_EXTERNAL_SERVER_UNREACHABLE mandaria al operador a revisar la red
      //    cuando lo que pasa es que la URL no apunta a un articulo.
      expect(result.error?.code).toBe(ERR_SCRAPER_EMPTY_CONTENT);
      expect(result.error?.level).toBe('GRAVE');
    });
  });

  describe('7. Liberacion de recursos', () => {
    it('7.1 deberia cerrar el contexto tras una extraccion con exito', async () => {
      // 1. Arrange
      const { strategy, closeContext } = createHarness(createPage());

      // 2. Act
      await strategy.execute(buildContext(), { targetUrl: TARGET_URL });

      // 3. Assert
      expect(closeContext).toHaveBeenCalledTimes(1);
    });

    it('7.2 deberia cerrar el contexto tambien cuando la navegacion falla', async () => {
      // 1. Arrange
      const page = createPage({
        goto: jest.fn().mockRejectedValue(timeoutError()),
      });
      const { strategy, closeContext } = createHarness(page);

      // 2. Act
      await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
        maxRetries: 0,
      });

      // 3. Assert: es el `finally`. Un contexto sin cerrar retiene su cache en
      //    la memoria del proceso de Chromium, que es residente: la fuga no se
      //    ve en el heap de Node y solo aparece como crecimiento del contenedor.
      expect(closeContext).toHaveBeenCalledTimes(1);
    });

    it('7.3 no deberia lanzar si el pool falla al crear el contexto', async () => {
      // 1. Arrange
      const strategy = new WebScraperStrategy({
        createContext: jest.fn().mockRejectedValue(new Error('Chromium caido')),
      } as unknown as BrowserPoolService);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
      });

      // 3. Assert: ninguna excepcion sale de `execute()`; el motor normalizaria
      //    cualquier fuga a URGENTE, que nunca se reintenta.
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
    });

    it('7.4 no deberia enmascarar el resultado si el cierre falla', async () => {
      // 1. Arrange
      const page = createPage();
      const strategy = new WebScraperStrategy({
        createContext: jest.fn().mockResolvedValue({
          newPage: jest.fn().mockResolvedValue(page),
          close: jest.fn().mockRejectedValue(new Error('ya estaba cerrado')),
        }),
      } as unknown as BrowserPoolService);
      jest
        .spyOn(strategy['logger'], 'warn')
        .mockImplementation(() => undefined);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
      });

      // 3. Assert: si el `finally` lanzara, sustituiria un exito ya decidido por
      //    una excepcion sobre la limpieza.
      expect(result.success).toBe(true);
    });
  });

  describe('8. Inmutabilidad del contexto', () => {
    it('8.1 no deberia escribir en el contexto que recibe', async () => {
      // 1. Arrange
      const { strategy } = createHarness(createPage());
      const context = buildContext({
        parsed_email: { extracted_urls: [TARGET_URL] },
      });
      const before = context.getAllContext();

      // 2. Act
      await strategy.execute(context, {
        targetUrl: '{{parsed_email.extracted_urls[0]}}',
      });

      // 3. Assert: nodo PURO. Devuelve `data` y es el motor quien la deposita en
      //    el `outputNamespace`.
      expect(context.getAllContext()).toEqual(before);
    });
  });
});
