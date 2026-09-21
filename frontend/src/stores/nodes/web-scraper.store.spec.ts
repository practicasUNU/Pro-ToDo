import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SCRAPER_MAX_RETRIES,
  DEFAULT_SCRAPER_RETRY_DELAY_MS,
  DEFAULT_SCRAPER_TIMEOUT_MS,
  SELECTABLE_URL_SLOTS,
  URL_SOURCE_NAMESPACE,
  urlTemplateFor,
  useWebScraperStore,
} from './web-scraper.store';

import type { CheckScraperResult, ScrapedWebPayload } from '@/types/web-scraper';

// Se dobla el SERVICIO y no axios: sin esto se cargaria `@boot/axios`, que
// necesita entorno de navegador. El import dinamico posterior es lo que permite
// tipar el doble sin `any`.
vi.mock('@services/nodes/web-scraper.service', () => ({
  checkScraper: vi.fn(),
}));

const webScraperService = await import('@services/nodes/web-scraper.service');
const checkScraper = vi.mocked(webScraperService.checkScraper);

const NODE_ID = 'extractor_web';
const SANDBOX_URL = 'https://www.ejemplo.es/noticias/nota-de-prensa';

const buildPreview = (overrides: Partial<ScrapedWebPayload> = {}): ScrapedWebPayload => ({
  source_url: SANDBOX_URL,
  article_title: 'Titular de la nota',
  full_article_content: 'Primer parrafo.\n\nSegundo parrafo.',
  byline: 'Redaccion Local',
  scraped_at: '2026-09-21T10:00:00.000Z',
  ...overrides,
});

const buildResult = (overrides: Partial<CheckScraperResult> = {}): CheckScraperResult => ({
  success: true,
  preview: buildPreview(),
  metrics: {
    elapsedMs: 1_234,
    attempts: 1,
    redirected: false,
    contentLength: 36,
  },
  ...overrides,
});

describe('useWebScraperStore · configuracion del nodo EXTRACTOR_WEB', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  describe('1. Selector determinista de URL', () => {
    it('1.1 deberia ofrecer una opcion por posicion del arreglo de enlaces', () => {
      // 1. Arrange & 2. Act
      const store = useWebScraperStore(NODE_ID);

      // 3. Assert
      expect(store.urlOptions).toHaveLength(SELECTABLE_URL_SLOTS);
    });

    it('1.2 deberia mapear cada opcion a su plantilla de interpolacion', () => {
      // 1. Arrange & 2. Act
      const store = useWebScraperStore(NODE_ID);

      // 3. Assert: es lo que el motor interpolara contra el contexto. Una
      //    etiqueta bonita con un valor mal formado solo fallaria al ejecutarse.
      expect(store.urlOptions[0]?.value).toBe('{{parsed_email.extracted_urls[0]}}');
      expect(store.urlOptions[1]?.value).toBe('{{parsed_email.extracted_urls[1]}}');
    });

    it('1.3 deberia arrancar apuntando al primer enlace del correo', () => {
      // 1. Arrange & 2. Act
      const store = useWebScraperStore(NODE_ID);

      // 3. Assert
      expect(store.config.targetUrl).toBe(urlTemplateFor(0));
    });
  });

  describe('2. Contrato isConfigValid', () => {
    it('2.1 deberia ser valido de salida con parsed_email aguas arriba', () => {
      // 1. Arrange & 2. Act
      const store = useWebScraperStore(NODE_ID);

      // 3. Assert
      expect(store.isConfigValid).toBe(true);
    });

    it.each(['', '   '])('2.2 deberia invalidar un targetUrl de %p', (targetUrl: string) => {
      // 1. Arrange
      const store = useWebScraperStore(NODE_ID);

      // 2. Act
      store.updateConfig({ targetUrl });

      // 3. Assert
      expect(store.isConfigValid).toBe(false);
    });

    it('2.3 deberia invalidar una plantilla fuera de la lista ofrecida', () => {
      // 1. Arrange: el selector es CERRADO (regla frontend-quasar.md §4), asi
      //    que el conjunto de valores legitimos es exactamente el que el store
      //    ofrece. Una plantilla bien formada hacia otro namespace pasaria un
      //    validador por patron y solo fallaria al ejecutar el flujo.
      const store = useWebScraperStore(NODE_ID);

      // 2. Act
      store.updateConfig({ targetUrl: '{{llm_response.url}}' });

      // 3. Assert
      expect(store.isConfigValid).toBe(false);
    });

    it('2.4 deberia invalidar si parsed_email no esta aguas arriba', () => {
      // 1. Arrange
      const store = useWebScraperStore(NODE_ID);

      // 2. Act: un EXTRACTOR_WEB colocado antes del parser, o en un flujo que
      //    arranca por cron sin parser.
      store.setAvailableUpstreamNamespaces(['raw_email']);

      // 3. Assert: sin el namespace, la plantilla no existe en el contexto y el
      //    nodo fallaria con ERR_SCRAPER_URL_UNRESOLVED en la primera ejecucion.
      expect(store.hasUrlSource).toBe(false);
      expect(store.isConfigValid).toBe(false);
    });
  });

  describe('3. Rangos numericos, espejo de los @Min/@Max del DTO', () => {
    it.each([4_999, 60_001, 1.5, Number.NaN])(
      '3.1 deberia rechazar un timeoutMs de %p',
      (timeoutMs: number) => {
        // 1. Arrange
        const store = useWebScraperStore(NODE_ID);

        // 2. Act
        store.updateConfig({ timeoutMs });

        // 3. Assert: sin esta copia el operador veria un 400 de servidor donde
        //    deberia haber visto una regla de campo.
        expect(store.isConfigValid).toBe(false);
      },
    );

    it('3.2 deberia aceptar los limites exactos del rango', () => {
      // 1. Arrange
      const store = useWebScraperStore(NODE_ID);

      // 2. Act
      store.updateConfig({
        timeoutMs: 5_000,
        maxRetries: 0,
        retryDelayMs: 500,
      });

      // 3. Assert
      expect(store.isConfigValid).toBe(true);
    });

    it.each([-1, 4])('3.3 deberia rechazar un maxRetries de %p', (maxRetries: number) => {
      // 1. Arrange
      const store = useWebScraperStore(NODE_ID);

      // 2. Act
      store.updateConfig({ maxRetries });

      // 3. Assert
      expect(store.isConfigValid).toBe(false);
    });

    it('3.4 deberia rechazar un retryDelayMs fuera de rango', () => {
      // 1. Arrange
      const store = useWebScraperStore(NODE_ID);

      // 2. Act
      store.updateConfig({ retryDelayMs: 100 });

      // 3. Assert
      expect(store.isConfigValid).toBe(false);
    });
  });

  describe('4. Contrato con el pipeline_schema', () => {
    it('4.1 deberia publicar solo targetUrl con los tres defectos intactos', () => {
      // 1. Arrange & 2. Act
      const store = useWebScraperStore(NODE_ID);

      // 3. Assert: congelar el defecto de hoy en cada esquema guardado haria que
      //    cambiarlo manana no alcanzase a ningun flujo existente.
      expect(store.toNodeParams()).toEqual({ targetUrl: urlTemplateFor(0) });
    });

    it('4.2 deberia publicar los numericos que difieren del defecto', () => {
      // 1. Arrange
      const store = useWebScraperStore(NODE_ID);

      // 2. Act
      store.updateConfig({ timeoutMs: 45_000, maxRetries: 0 });

      // 3. Assert
      expect(store.toNodeParams()).toEqual({
        targetUrl: urlTemplateFor(0),
        timeoutMs: 45_000,
        maxRetries: 0,
      });
    });

    it('4.3 deberia reproducir los params tras hidratar, ida y vuelta', () => {
      // 1. Arrange
      const store = useWebScraperStore(NODE_ID);
      const params = {
        targetUrl: urlTemplateFor(2),
        timeoutMs: 30_000,
        retryDelayMs: 5_000,
      };

      // 2. Act
      store.hydrateFromNode({ outputNamespace: 'scraped_web', params });

      // 3. Assert: es el contrato que hace posible EDITAR un flujo en vez de
      //    solo crearlo; sin el, guardar borraria lo que se venia a retocar.
      expect(store.toNodeParams()).toEqual(params);
    });

    it('4.4 deberia tolerar un jsonb con el tipo equivocado', () => {
      // 1. Arrange: `pipeline_schema` es una columna `jsonb` y pudo escribirse
      //    por SQL directo o por una version anterior del asistente.
      const store = useWebScraperStore(NODE_ID);

      // 2. Act
      store.hydrateFromNode({
        outputNamespace: 'scraped_web',
        params: { targetUrl: 42, timeoutMs: 'mucho' },
      });

      // 3. Assert
      expect(store.config.targetUrl).toBe(urlTemplateFor(0));
      expect(store.config.timeoutMs).toBe(DEFAULT_SCRAPER_TIMEOUT_MS);
    });

    it('4.5 deberia devolver todo a su estado inicial con resetConfig', () => {
      // 1. Arrange
      const store = useWebScraperStore(NODE_ID);
      store.updateConfig({ timeoutMs: 45_000 });
      store.setSandboxUrl(SANDBOX_URL);

      // 2. Act
      store.resetConfig();

      // 3. Assert: sin esto, empezar un flujo nuevo arrancaria con los `params`
      //    del anterior, porque la instancia sobrevive a la topologia.
      expect(store.config.timeoutMs).toBe(DEFAULT_SCRAPER_TIMEOUT_MS);
      expect(store.config.maxRetries).toBe(DEFAULT_SCRAPER_MAX_RETRIES);
      expect(store.config.retryDelayMs).toBe(DEFAULT_SCRAPER_RETRY_DELAY_MS);
      expect(store.sandboxUrl).toBe('');
    });
  });

  describe('5. Banco de pruebas', () => {
    it('5.1 deberia enviar la URL REAL del banco y NO la plantilla de config', async () => {
      // 1. Arrange: es el UNICO punto donde el banco de pruebas y la
      //    configuracion se separan. `config.targetUrl` es una plantilla contra
      //    un contexto que en tiempo de diseno no existe, y el DTO del backend
      //    la rechaza con un 400 por su `@IsUrl`: mandarla haria el endpoint
      //    inutilizable.
      const store = useWebScraperStore(NODE_ID);
      store.setSandboxUrl(SANDBOX_URL);
      checkScraper.mockResolvedValue(buildResult());

      // 2. Act
      await store.runSandboxTest();

      // 3. Assert
      expect(checkScraper.mock.calls[0]?.[0].targetUrl).toBe(SANDBOX_URL);
      expect(store.config.targetUrl).toBe(urlTemplateFor(0));
    });

    it('5.2 deberia guardar la vista previa y las metricas y apagar loading', async () => {
      // 1. Arrange
      const store = useWebScraperStore(NODE_ID);
      store.setSandboxUrl(SANDBOX_URL);
      checkScraper.mockResolvedValue(buildResult());

      // 2. Act
      await store.runSandboxTest();

      // 3. Assert
      expect(store.sandboxResult?.article_title).toBe('Titular de la nota');
      expect(store.sandboxMetrics?.attempts).toBe(1);
      expect(store.loading).toBe(false);
    });

    it('5.3 deberia dejar sin vista previa un fallo diagnosticado', async () => {
      // 1. Arrange: un muro de pago llega como 200 con `success: false`, no como
      //    excepcion: el diagnostico del portal ES la respuesta.
      const store = useWebScraperStore(NODE_ID);
      store.setSandboxUrl(SANDBOX_URL);
      checkScraper.mockResolvedValue({
        success: false,
        metrics: {
          elapsedMs: 900,
          attempts: 1,
          redirected: false,
          contentLength: 0,
        },
        error: {
          level: 'GRAVE',
          code: 'ERR_ACCESS_DENIED_BLOCK_DETECTED',
          message: 'Acceso denegado: muro de pago.',
        },
      });

      // 2. Act
      await store.runSandboxTest();

      // 3. Assert: el codigo se muestra porque distinguir un bloqueo de una
      //    pagina sin articulo es la diferencia entre "cambia de fuente" y
      //    "sube el timeout".
      expect(store.sandboxResult).toBeNull();
      expect(store.sandboxWarnings[0]).toContain('ERR_ACCESS_DENIED_BLOCK_DETECTED');
      expect(store.loading).toBe(false);
    });

    it('5.4 deberia propagar la excepcion y apagar loading igualmente', async () => {
      // 1. Arrange: el store NO captura; el mensaje al usuario lo decide el
      //    componente (`frontend-architecture.md` §2.1). El `finally` solo
      //    garantiza que el boton deje de girar.
      const store = useWebScraperStore(NODE_ID);
      store.setSandboxUrl(SANDBOX_URL);
      checkScraper.mockRejectedValue(new Error('Network Error'));

      // 2. Act & 3. Assert
      await expect(store.runSandboxTest()).rejects.toThrow('Network Error');
      expect(store.loading).toBe(false);
    });

    it('5.5 deberia caducar el resultado al cambiar un parametro', async () => {
      // 1. Arrange
      const store = useWebScraperStore(NODE_ID);
      store.setSandboxUrl(SANDBOX_URL);
      checkScraper.mockResolvedValue(buildResult());
      await store.runSandboxTest();

      // 2. Act
      store.updateConfig({ timeoutMs: 45_000 });

      // 3. Assert: un panel que sobrevive al cambio del parametro que lo produjo
      //    afirma sobre una configuracion que ya no es la que hay.
      expect(store.sandboxResult).toBeNull();
    });

    it('5.6 deberia exigir una URL para poder probar', () => {
      // 1. Arrange & 2. Act
      const store = useWebScraperStore(NODE_ID);

      // 3. Assert
      expect(store.canRunSandbox).toBe(false);

      store.setSandboxUrl(SANDBOX_URL);

      expect(store.canRunSandbox).toBe(true);
    });
  });

  describe('6. Avisos que no bloquean', () => {
    it('6.1 deberia avisar de la extraccion sin probar sin invalidar el paso', () => {
      // 1. Arrange & 2. Act
      const store = useWebScraperStore(NODE_ID);

      // 3. Assert: exigir la prueba bloquearia el paso con una verificacion que,
      //    por construccion, se hace sobre OTRA url que la de produccion.
      expect(store.configWarnings.join(' ')).toContain('No se ha probado');
      expect(store.isConfigValid).toBe(true);
    });

    it('6.2 deberia avisar de la multiplicacion con el retryPolicy del flujo', () => {
      // 1. Arrange & 2. Act
      const store = useWebScraperStore(NODE_ID);

      // 3. Assert: es el aviso que el TSDoc del DTO del backend pide que alguien
      //    de, y que sin esto no da nadie.
      expect(store.configWarnings.join(' ')).toContain('se multiplican');
    });

    it('6.3 no deberia avisar de los reintentos con maxRetries en cero', () => {
      // 1. Arrange
      const store = useWebScraperStore(NODE_ID);

      // 2. Act
      store.updateConfig({ maxRetries: 0 });

      // 3. Assert
      expect(store.configWarnings.join(' ')).not.toContain('se multiplican');
    });
  });

  describe('7. Aislamiento por nodeId', () => {
    it('7.1 no deberia compartir estado entre dos extractores del mismo flujo', () => {
      // 1. Arrange
      const first = useWebScraperStore('extractor_uno');
      const second = useWebScraperStore('extractor_dos');

      // 2. Act: un flujo puede extraer dos enlaces distintos del mismo correo.
      first.updateConfig({ targetUrl: urlTemplateFor(3) });

      // 3. Assert
      expect(second.config.targetUrl).toBe(urlTemplateFor(0));
    });

    it('7.2 deberia devolver la MISMA instancia para el mismo nodeId', () => {
      // 1. Arrange & 2. Act
      const first = useWebScraperStore(NODE_ID);
      const second = useWebScraperStore(NODE_ID);

      // 3. Assert
      expect(first).toBe(second);
    });
  });

  describe('8. Namespaces aguas arriba', () => {
    it('8.1 deberia aceptar el namespace del parser como fuente de enlaces', () => {
      // 1. Arrange
      const store = useWebScraperStore(NODE_ID);

      // 2. Act
      store.setAvailableUpstreamNamespaces(['raw_email', URL_SOURCE_NAMESPACE]);

      // 3. Assert
      expect(store.hasUrlSource).toBe(true);
    });
  });
});
