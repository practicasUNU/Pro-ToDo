import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SCRAPER_IGNORE_EXTRACTION_FAILURE,
  DEFAULT_SCRAPER_MAX_RETRIES,
  EXCLUDED_DOMAIN_SUGGESTIONS,
  FIRST_ELIGIBLE_LABEL_SUFFIX,
  MAX_EXCLUDED_DOMAINS,
  DEFAULT_SCRAPER_RETRY_DELAY_MS,
  DEFAULT_SCRAPER_TIMEOUT_MS,
  indexedUrlTemplateFor,
  SELECTABLE_URL_SLOTS,
  useWebScraperStore,
} from './web-scraper.store';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';
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

/**
 * Contexto que dejaria un TRIGGER_IMAP seguido de un PARSER_PRE_IA.
 *
 * Los campos son los que el catalogo del backend declara para esas estrategias.
 * El store arranca SIN contexto —no hay origen por defecto que valga para todo
 * flujo—, asi que casi toda prueba necesita sembrarlo primero.
 */
const PARSER_UPSTREAM: UpstreamNamespace[] = [
  { namespace: 'raw_email', fields: [{ name: 'subject', type: 'text' }] },
  {
    namespace: 'parsed_email',
    fields: [
      { name: 'clean_body', type: 'text' },
      { name: 'extracted_urls', type: 'url[]' },
    ],
  },
];

/** Plantilla de la posicion `index` de los enlaces del parser. */
const parsedEmailUrl = (index: number): string =>
  indexedUrlTemplateFor('parsed_email', 'extracted_urls', index);

/** Store con el contexto del parser y el primer enlace ya elegido. */
const buildConfiguredStore = (nodeId: string = NODE_ID): ReturnType<typeof useWebScraperStore> => {
  const store = useWebScraperStore(nodeId);

  store.setAvailableUpstreamContext(PARSER_UPSTREAM);
  store.updateConfig({ targetUrl: parsedEmailUrl(0) });

  return store;
};

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
    it('1.1 deberia arrancar SIN opciones y SIN targetUrl elegido', () => {
      // 1. Arrange & 2. Act: el store no sabe nada del flujo hasta que el
      //    anfitrion se lo cuenta.
      const store = useWebScraperStore(NODE_ID);

      // 3. Assert: sembrar un defecto significaria ofrecer opciones sobre un
      //    nodo que quiza no esta en el flujo, y dejar avanzar el asistente con
      //    una referencia que ninguna ejecucion sabria resolver.
      expect(store.urlOptions).toEqual([]);
      expect(store.config.targetUrl).toBe('');
      expect(store.hasUrlSource).toBe(false);
    });

    it('1.2 deberia desplegar un campo url[] en SELECTABLE_URL_SLOTS posiciones', () => {
      // 1. Arrange
      const store = useWebScraperStore(NODE_ID);

      // 2. Act
      store.setAvailableUpstreamContext(PARSER_UPSTREAM);

      // 3. Assert: el unico campo de tipo URL del contexto es `extracted_urls`,
      //    y encabeza sus posiciones la opcion que delega la eleccion en el
      //    nodo (el arreglo entero, sin indice).
      expect(store.urlOptions).toHaveLength(SELECTABLE_URL_SLOTS + 1);
      expect(store.urlOptions[0]?.value).toBe('{{parsed_email.extracted_urls}}');
      expect(store.urlOptions[0]?.label).toContain(FIRST_ELIGIBLE_LABEL_SUFFIX);
      expect(store.urlOptions[1]?.value).toBe('{{parsed_email.extracted_urls[0]}}');
      expect(store.urlOptions[2]?.value).toBe('{{parsed_email.extracted_urls[1]}}');
    });

    it('1.3 deberia ofrecer una sola opcion por cada campo url escalar', () => {
      // 1. Arrange
      const store = useWebScraperStore(NODE_ID);

      // 2. Act: un segundo extractor encadenado puede partir de la URL final
      //    del primero.
      store.setAvailableUpstreamContext([
        {
          namespace: 'scraped_web',
          fields: [
            { name: 'source_url', type: 'url' },
            { name: 'article_title', type: 'text' },
          ],
        },
      ]);

      // 3. Assert
      expect(store.urlOptions).toHaveLength(1);
      expect(store.urlOptions[0]?.value).toBe('{{scraped_web.source_url}}');
    });

    it('1.4 NO deberia ofrecer campos que no sean de tipo URL', () => {
      // 1. Arrange
      const store = useWebScraperStore(NODE_ID);

      // 2. Act
      store.setAvailableUpstreamContext([
        {
          namespace: 'parsed_email',
          fields: [
            { name: 'clean_body', type: 'text' },
            { name: 'character_count', type: 'number' },
          ],
        },
      ]);

      // 3. Assert: un `character_count` es interpolable igual que cualquier
      //    otro, pero ofrecerlo como origen de una direccion seria exactamente
      //    el error de tipeo que el selector existe para impedir.
      expect(store.urlOptions).toEqual([]);
      expect(store.hasUrlSource).toBe(false);
    });

    it('1.5 deberia componer opciones de TODOS los namespaces anteriores', () => {
      // 1. Arrange
      const store = useWebScraperStore(NODE_ID);

      // 2. Act
      store.setAvailableUpstreamContext([
        ...PARSER_UPSTREAM,
        {
          namespace: 'scraped_web',
          fields: [{ name: 'source_url', type: 'url' }],
        },
      ]);

      // 3. Assert: la lista es la proyeccion de la TOPOLOGIA, no una constante.
      //    Esta es la regresion que impide volver al `parsed_email` fijo.
      const values = store.urlOptions.map((option) => option.value);

      expect(values).toContain('{{parsed_email.extracted_urls[0]}}');
      expect(values).toContain('{{scraped_web.source_url}}');
    });

    it('1.6 deberia reaccionar a un cambio de topologia sin recrear el store', () => {
      // 1. Arrange: el operador retrocede y quita el parser del flujo.
      const store = buildConfiguredStore();
      expect(store.urlOptions.length).toBeGreaterThan(0);

      // 2. Act
      store.setAvailableUpstreamContext([]);

      // 3. Assert
      expect(store.urlOptions).toEqual([]);
      expect(store.isConfigValid).toBe(false);
    });
  });

  describe('2. Contrato isConfigValid', () => {
    it('2.1 deberia ser valido con el contexto sembrado y un origen elegido', () => {
      // 1. Arrange & 2. Act
      const store = buildConfiguredStore();

      // 3. Assert
      expect(store.isConfigValid).toBe(true);
    });

    it('2.2 NO deberia ser valido solo por tener contexto, sin elegir origen', () => {
      // 1. Arrange: `skipIfEmpty: false` explicito. Con el defecto (`true`) la
      //    ausencia de origen es una decision declarada; ver el bloque 7.
      const store = useWebScraperStore(NODE_ID);

      // 2. Act
      store.setAvailableUpstreamContext(PARSER_UPSTREAM);
      store.updateConfig({ skipIfEmpty: false });

      // 3. Assert: hay opciones, pero nadie ha elegido ninguna.
      expect(store.urlOptions.length).toBeGreaterThan(0);
      expect(store.isConfigValid).toBe(false);
    });

    it.each(['', '   '])('2.3 deberia invalidar un targetUrl de %p', (targetUrl: string) => {
      // 1. Arrange
      const store = buildConfiguredStore();

      // 2. Act
      store.updateConfig({ targetUrl, skipIfEmpty: false });

      // 3. Assert
      expect(store.isConfigValid).toBe(false);
    });

    it('2.4 deberia invalidar una plantilla fuera de la lista ofrecida', () => {
      // 1. Arrange: el selector es CERRADO (regla frontend-quasar.md §4), asi
      //    que el conjunto de valores legitimos es exactamente el que el store
      //    ofrece. Una plantilla bien formada hacia otro namespace pasaria un
      //    validador por patron y solo fallaria al ejecutar el flujo.
      const store = buildConfiguredStore();

      // 2. Act
      store.updateConfig({ targetUrl: '{{llm_response.url}}' });

      // 3. Assert
      expect(store.isConfigValid).toBe(false);
    });

    it('2.5 deberia invalidar una URL literal aunque el contexto este completo', () => {
      // 1. Arrange: es lo que admitia una version anterior del nodo, y lo que el
      //    `@Matches` del DTO del backend ya rechaza.
      const store = buildConfiguredStore();

      // 2. Act
      store.updateConfig({ targetUrl: SANDBOX_URL });

      // 3. Assert
      expect(store.isConfigValid).toBe(false);
    });

    it('2.6 deberia invalidar una marca embebida en una URL literal', () => {
      // 1. Arrange: el anclaje del patron no es cosmetico; sin el, esto seria
      //    una URL literal disfrazada.
      const store = buildConfiguredStore();

      // 2. Act
      store.updateConfig({
        targetUrl: 'https://otro-portal.es/?x={{parsed_email.extracted_urls[0]}}',
      });

      // 3. Assert
      expect(store.isConfigValid).toBe(false);
    });

    it('2.7 deberia invalidar si el flujo deja de producir el origen elegido', () => {
      // 1. Arrange
      const store = buildConfiguredStore();

      // 2. Act: un EXTRACTOR_WEB colocado antes del parser, o en un flujo que
      //    arranca por cron sin parser.
      store.setAvailableUpstreamContext([
        { namespace: 'raw_email', fields: [{ name: 'subject', type: 'text' }] },
      ]);

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
        const store = buildConfiguredStore();

        // 2. Act
        store.updateConfig({ timeoutMs });

        // 3. Assert: sin esta copia el operador veria un 400 de servidor donde
        //    deberia haber visto una regla de campo.
        expect(store.isConfigValid).toBe(false);
      },
    );

    it('3.2 deberia aceptar los limites exactos del rango', () => {
      // 1. Arrange
      const store = buildConfiguredStore();

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
      const store = buildConfiguredStore();

      // 2. Act
      store.updateConfig({ maxRetries });

      // 3. Assert
      expect(store.isConfigValid).toBe(false);
    });

    it('3.4 deberia rechazar un retryDelayMs fuera de rango', () => {
      // 1. Arrange
      const store = buildConfiguredStore();

      // 2. Act
      store.updateConfig({ retryDelayMs: 100 });

      // 3. Assert
      expect(store.isConfigValid).toBe(false);
    });
  });

  describe('4. Contrato con el pipeline_schema', () => {
    it('4.1 deberia publicar solo targetUrl con los tres defectos intactos', () => {
      // 1. Arrange & 2. Act
      const store = buildConfiguredStore();

      // 3. Assert: congelar el defecto de hoy en cada esquema guardado haria que
      //    cambiarlo manana no alcanzase a ningun flujo existente.
      expect(store.toNodeParams()).toEqual({
        targetUrl: parsedEmailUrl(0),
        // Los numericos se omiten; `skipIfEmpty` NO. Ver el bloque 7.
        skipIfEmpty: true,
      });
    });

    it('4.1bis deberia OMITIR targetUrl cuando no se ha elegido origen', () => {
      // 1. Arrange & 2. Act: sin contexto no hay nada que elegir.
      const store = useWebScraperStore(NODE_ID);

      // 3. Assert: se omite en vez de publicar `''`. Un nodo sin origen es un
      //    nodo sin configurar, y asi lo declara una plantilla de flujo: por
      //    ausencia. Publicar la cadena vacia seria afirmar que hay un valor, y
      //    el `@IsNotEmpty` del DTO lo rechazaria al guardar — que es justo lo
      //    que impedia que una plantilla contuviera este nodo.
      expect(store.toNodeParams()).toEqual({ skipIfEmpty: true });
    });

    it('4.2 deberia publicar los numericos que difieren del defecto', () => {
      // 1. Arrange
      const store = buildConfiguredStore();

      // 2. Act
      store.updateConfig({ timeoutMs: 45_000, maxRetries: 0 });

      // 3. Assert
      expect(store.toNodeParams()).toEqual({
        targetUrl: parsedEmailUrl(0),
        timeoutMs: 45_000,
        maxRetries: 0,
        skipIfEmpty: true,
      });
    });

    it('4.3 deberia reproducir los params tras hidratar, ida y vuelta', () => {
      // 1. Arrange
      const store = useWebScraperStore(NODE_ID);
      const params = {
        targetUrl: parsedEmailUrl(2),
        timeoutMs: 30_000,
        retryDelayMs: 5_000,
      };

      // 2. Act
      store.hydrateFromNode({ outputNamespace: 'scraped_web', params });

      // 3. Assert: es el contrato que hace posible EDITAR un flujo en vez de
      //    solo crearlo; sin el, guardar borraria lo que se venia a retocar.
      //    `skipIfEmpty` se SUMA aunque el nodo guardado no lo trajera: es
      //    exactamente la reparacion de este cambio —un esquema anterior a la
      //    bandera queda explicito en cuanto alguien lo reabre y lo guarda.
      expect(store.toNodeParams()).toEqual({ ...params, skipIfEmpty: true });
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

      // 3. Assert: `targetUrl` cae a vacio y NO a una plantilla inventada; los
      //    numericos si tienen defecto porque el backend tambien lo aplica.
      expect(store.config.targetUrl).toBe('');
      expect(store.config.timeoutMs).toBe(DEFAULT_SCRAPER_TIMEOUT_MS);
    });

    it('4.6 deberia conservar VERBATIM un targetUrl que ya no es ofrecible', () => {
      // 1. Arrange: un flujo guardado cuando el parser iba delante, reabierto
      //    despues de reordenarlo.
      const store = useWebScraperStore(NODE_ID);
      store.setAvailableUpstreamContext([]);

      // 2. Act
      store.hydrateFromNode({
        outputNamespace: 'scraped_web',
        params: { targetUrl: parsedEmailUrl(2) },
      });

      // 3. Assert: reescribirlo en silencio abriria el formulario afirmando una
      //    eleccion que nadie hizo, y guardar la persistiria. Se conserva, el
      //    paso queda bloqueado y el aviso explica por que.
      expect(store.config.targetUrl).toBe(parsedEmailUrl(2));
      expect(store.hasStaleTargetUrl).toBe(true);
      expect(store.isConfigValid).toBe(false);
      expect(store.configWarnings.join(' ')).toContain('ya no lo produce');
    });

    it('4.5 deberia devolver todo a su estado inicial con resetConfig', () => {
      // 1. Arrange
      const store = buildConfiguredStore();
      store.updateConfig({ timeoutMs: 45_000 });
      store.setSandboxUrl(SANDBOX_URL);

      // 2. Act
      store.resetConfig();

      // 3. Assert: sin esto, empezar un flujo nuevo arrancaria con los `params`
      //    del anterior, porque la instancia sobrevive a la topologia.
      expect(store.config.timeoutMs).toBe(DEFAULT_SCRAPER_TIMEOUT_MS);
      expect(store.config.maxRetries).toBe(DEFAULT_SCRAPER_MAX_RETRIES);
      expect(store.config.retryDelayMs).toBe(DEFAULT_SCRAPER_RETRY_DELAY_MS);
      expect(store.config.targetUrl).toBe('');
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
      const store = buildConfiguredStore();
      store.setSandboxUrl(SANDBOX_URL);
      checkScraper.mockResolvedValue(buildResult());

      // 2. Act
      await store.runSandboxTest();

      // 3. Assert
      expect(checkScraper.mock.calls[0]?.[0].targetUrl).toBe(SANDBOX_URL);
      expect(store.config.targetUrl).toBe(parsedEmailUrl(0));
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
      const store = buildConfiguredStore();

      // 3. Assert: exigir la prueba bloquearia el paso con una verificacion que,
      //    por construccion, se hace sobre OTRA url que la de produccion.
      expect(store.configWarnings.join(' ')).toContain('No se ha probado');
      expect(store.isConfigValid).toBe(true);
    });

    it('6.2 deberia avisar de la multiplicacion con el retryPolicy del flujo', () => {
      // 1. Arrange & 2. Act
      const store = buildConfiguredStore();

      // 3. Assert: es el aviso que el TSDoc del DTO del backend pide que alguien
      //    de, y que sin esto no da nadie.
      expect(store.configWarnings.join(' ')).toContain('se multiplican');
    });

    it('6.3 no deberia avisar de los reintentos con maxRetries en cero', () => {
      // 1. Arrange
      const store = buildConfiguredStore();

      // 2. Act
      store.updateConfig({ maxRetries: 0 });

      // 3. Assert
      expect(store.configWarnings.join(' ')).not.toContain('se multiplican');
    });
  });

  describe('7. Aislamiento por nodeId', () => {
    it('7.1 no deberia compartir estado entre dos extractores del mismo flujo', () => {
      // 1. Arrange
      const first = buildConfiguredStore('extractor_uno');
      const second = buildConfiguredStore('extractor_dos');

      // 2. Act: un flujo puede extraer dos enlaces distintos del mismo correo.
      first.updateConfig({ targetUrl: parsedEmailUrl(3) });

      // 3. Assert
      expect(second.config.targetUrl).toBe(parsedEmailUrl(0));
    });

    it('7.2 deberia devolver la MISMA instancia para el mismo nodeId', () => {
      // 1. Arrange & 2. Act
      const first = useWebScraperStore(NODE_ID);
      const second = useWebScraperStore(NODE_ID);

      // 3. Assert
      expect(first).toBe(second);
    });
  });

  describe('8. Contexto aguas arriba', () => {
    it('8.1 deberia aceptar el namespace del parser como fuente de enlaces', () => {
      // 1. Arrange
      const store = useWebScraperStore(NODE_ID);

      // 2. Act
      store.setAvailableUpstreamContext(PARSER_UPSTREAM);

      // 3. Assert
      expect(store.hasUrlSource).toBe(true);
    });

    it('8.2 deberia tratar un namespace sin campos como "nada que ofrecer"', () => {
      // 1. Arrange: es lo que llega cuando el catalogo del backend aun no ha
      //    cargado, o cuando el tipo de nodo no declara sus campos de salida.
      const store = useWebScraperStore(NODE_ID);

      // 2. Act
      store.setAvailableUpstreamContext([{ namespace: 'parsed_email', fields: [] }]);

      // 3. Assert: vacio nunca es un error, es un "todavia no"
      expect(store.urlOptions).toEqual([]);
      expect(store.hasUrlSource).toBe(false);
    });

    it('8.3 deberia copiar el contexto recibido y no guardar la referencia', () => {
      // 1. Arrange
      const store = useWebScraperStore(NODE_ID);
      const context = [...PARSER_UPSTREAM];

      // 2. Act
      store.setAvailableUpstreamContext(context);
      context.length = 0;

      // 3. Assert: si guardara la referencia, que el anfitrion reutilizara su
      //    arreglo vaciaria el selector por la espalda.
      expect(store.urlOptions.length).toBeGreaterThan(0);
    });
  });

  describe('7. Fallback neutro declarado (skipIfEmpty)', () => {
    it('7.1 deberia venir activo por defecto', () => {
      // 1. Arrange & 2. Act
      const store = useWebScraperStore(NODE_ID);

      // 3. Assert: replica `DEFAULT_SCRAPER_SKIP_IF_EMPTY` del DTO del backend.
      expect(store.config.skipIfEmpty).toBe(true);
    });

    it('7.2 deberia validar sin origen cuando la bandera esta activa', () => {
      // 1. Arrange: la contingencia OCR. No hay nada aguas arriba que publique
      //    una URL, y el stepper tiene que dejar avanzar igualmente.
      const store = useWebScraperStore(NODE_ID);

      // 2. Act
      store.setAvailableUpstreamContext([]);

      // 3. Assert
      expect(store.urlOptions).toEqual([]);
      expect(store.isConfigValid).toBe(true);
    });

    it('7.3 NO deberia encubrir un targetUrl obsoleto', () => {
      // 1. Arrange: la asimetria que sostiene el Poka-Yoke. "Omitir si no hay"
      //    no es "omitir si esta mal": una configuracion rota tiene que verse.
      const store = buildConfiguredStore();

      // 2. Act: el operador retrocede y quita de en medio al productor.
      store.setAvailableUpstreamContext([]);

      // 3. Assert
      expect(store.hasStaleTargetUrl).toBe(true);
      expect(store.config.skipIfEmpty).toBe(true);
      expect(store.isConfigValid).toBe(false);
    });

    it('7.4 no deberia eximir de los rangos numericos', () => {
      // 1. Arrange
      const store = useWebScraperStore(NODE_ID);

      // 2. Act: la bandera habla del ORIGEN, no de los tiempos.
      store.updateConfig({ timeoutMs: 100 });

      // 3. Assert
      expect(store.isConfigValid).toBe(false);
    });

    it('7.5 deberia avisar sin bloquear cuando el nodo se va a saltar', () => {
      // 1. Arrange & 2. Act
      const store = useWebScraperStore(NODE_ID);

      // 3. Assert: el precio del defecto `true` se paga aqui, en voz alta.
      expect(store.isConfigValid).toBe(true);
      expect(store.configWarnings.join(' ')).toContain('Este nodo se saltara');
    });

    it('7.6 deberia publicar skipIfEmpty SIEMPRE, tambien con el defecto', () => {
      // 1. Arrange 📐: este aserto es la reparacion del fallo reportado. Con el
      //    criterio de los numericos —publicar solo si difiere del defecto— la
      //    clave no se escribia nunca en el caso normal, y la regla 8 del
      //    backend, que exige el `true` LITERAL, seguia rechazando el flujo de
      //    contingencia con el toggle visiblemente encendido.
      const store = buildConfiguredStore();

      // 2. Act & 3. Assert
      expect(store.toNodeParams().skipIfEmpty).toBe(true);

      store.updateConfig({ skipIfEmpty: false });

      expect(store.toNodeParams().skipIfEmpty).toBe(false);
    });

    it('7.8 deberia recoger el skipIfEmpty que sembro la plantilla', () => {
      // 1. Arrange 📐: canal aparte de `hydrateFromNode`. Son las decisiones
      //    del disenador del flujo llegando al operador que lo instancia.
      const store = useWebScraperStore(NODE_ID);

      // 2. Act
      store.applyTemplateParams({ skipIfEmpty: false });

      // 3. Assert
      expect(store.config.skipIfEmpty).toBe(false);
    });

    it('7.9 deberia ignorar un skipIfEmpty de plantilla que no sea booleano', () => {
      // 1. Arrange 📐: la cadena `'false'` es *truthy*, y un `jsonb` escrito a
      //    mano puede traerla.
      const store = useWebScraperStore(NODE_ID);

      // 2. Act
      store.applyTemplateParams({ skipIfEmpty: 'false' });

      // 3. Assert
      expect(store.config.skipIfEmpty).toBe(true);
    });

    it('7.10 deberia bloquear el toggle sin origen aguas arriba', () => {
      // 1. Arrange
      const store = useWebScraperStore(NODE_ID);

      // 2. Act & 3. Assert: apagarlo produciria un esquema que la regla 8
      //    rechaza al guardar, asi que no se ofrece la eleccion.
      expect(store.isSkipIfEmptyLocked).toBe(true);

      store.setAvailableUpstreamContext(PARSER_UPSTREAM);

      expect(store.isSkipIfEmptyLocked).toBe(false);
    });

    it('7.7 deberia restaurar skipIfEmpty desde el nodo guardado', () => {
      // 1. Arrange
      const store = buildConfiguredStore();

      // 2. Act
      store.hydrateFromNode({
        outputNamespace: 'scraped_web',
        params: { skipIfEmpty: false },
      });

      // 3. Assert: y la coercion defensiva cubre un `jsonb` escrito a mano.
      expect(store.config.skipIfEmpty).toBe(false);

      store.hydrateFromNode({
        outputNamespace: 'scraped_web',
        params: { skipIfEmpty: 'si' },
      });

      expect(store.config.skipIfEmpty).toBe(true);
    });
  });

  /**
   * El filtro editorial que evita raspar el portal institucional propio.
   *
   * El correo trae su enlace como metadato de enrutado para el destino, no como
   * la noticia, y su posicion en la lista cambia de un dia para otro.
   */
  describe('9. Dominios excluidos y origen por criterio', () => {
    const LIST_TEMPLATE = '{{parsed_email.extracted_urls}}';

    it('9.1 deberia arrancar sin ningun dominio excluido', () => {
      // 1. Arrange & 2. Act: el backend mantiene su DTO neutro y el store
      //    tampoco siembra nada; la sugerencia solo se OFRECE.
      const store = useWebScraperStore(NODE_ID);

      // 3. Assert
      expect(store.config.excludedDomains).toEqual([]);
      expect(EXCLUDED_DOMAIN_SUGGESTIONS).toContain('madrimasd.org');
    });

    it('9.2 deberia invalidar un dominio que no sea solo el host', () => {
      // 1. Arrange
      const store = buildConfiguredStore();

      // 2. Act
      store.updateConfig({ excludedDomains: ['https://madrimasd.org/portal'] });

      // 3. Assert: se bloquea el paso aqui, no con el 400 del guardado.
      expect(store.areExcludedDomainsValid).toBe(false);
      expect(store.isConfigValid).toBe(false);
    });

    it('9.3 deberia invalidar una lista mas larga que el tope', () => {
      // 1. Arrange
      const store = buildConfiguredStore();

      // 2. Act
      store.updateConfig({
        excludedDomains: Array.from(
          { length: MAX_EXCLUDED_DOMAINS + 1 },
          (_, index) => `portal-${index}.example`,
        ),
      });

      // 3. Assert
      expect(store.isConfigValid).toBe(false);
    });

    it('9.4 deberia dar por valido el origen por criterio con dominios bien escritos', () => {
      // 1. Arrange
      const store = buildConfiguredStore();

      // 2. Act
      store.updateConfig({
        targetUrl: LIST_TEMPLATE,
        excludedDomains: ['madrimasd.org'],
      });

      // 3. Assert
      expect(store.isFirstEligibleTarget).toBe(true);
      expect(store.isConfigValid).toBe(true);
    });

    it('9.5 no deberia tomar una posicion fija por origen por criterio', () => {
      // 1. Arrange & 2. Act: el modo se lee de la FORMA del origen, igual que
      //    en la estrategia del backend.
      const store = buildConfiguredStore();

      // 3. Assert
      expect(store.config.targetUrl).toBe(parsedEmailUrl(0));
      expect(store.isFirstEligibleTarget).toBe(false);
    });

    it('9.6 deberia avisar del criterio sin ningun dominio excluido', () => {
      // 1. Arrange
      const store = buildConfiguredStore();

      // 2. Act
      store.updateConfig({ targetUrl: LIST_TEMPLATE, excludedDomains: [] });

      // 3. Assert: no bloquea; solo dice que hoy equivale a la posicion 1.
      expect(store.isConfigValid).toBe(true);
      expect(store.configWarnings.some((warning) => warning.includes('posicion 1'))).toBe(true);
    });

    it('9.7 deberia avisar de dominios excluidos con una posicion fija', () => {
      // 1. Arrange: el caso inverso, dominios que nadie llegara a consultar.
      const store = buildConfiguredStore();

      // 2. Act
      store.updateConfig({ excludedDomains: ['madrimasd.org'] });

      // 3. Assert
      expect(
        store.configWarnings.some((warning) => warning.includes('posicion fija')),
      ).toBe(true);
    });

    it('9.8 deberia publicar la lista solo cuando no esta vacia', () => {
      // 1. Arrange
      const store = buildConfiguredStore();

      // 2. Act & 3. Assert: ausencia es "no filtra nada".
      expect(store.toNodeParams()).not.toHaveProperty('excludedDomains');

      store.updateConfig({ excludedDomains: ['madrimasd.org'] });

      expect(store.toNodeParams().excludedDomains).toEqual(['madrimasd.org']);
    });

    it('9.9 deberia restaurar la lista de un nodo guardado, con coercion', () => {
      // 1. Arrange
      const store = buildConfiguredStore();

      // 2. Act: `pipeline_schema` es `jsonb` y pudo escribirse por SQL directo.
      store.hydrateFromNode({
        outputNamespace: 'scraped_web',
        params: { excludedDomains: ['madrimasd.org', 42, null] },
      });

      // 3. Assert
      expect(store.config.excludedDomains).toEqual(['madrimasd.org']);
    });

    it('9.10 deberia conservar los dominios que sembro la plantilla', () => {
      // 1. Arrange: son una decision editorial del disenador de la plantilla,
      //    no un valor de calibracion del flujo concreto.
      const store = buildConfiguredStore();

      // 2. Act
      store.applyTemplateParams({
        skipIfEmpty: false,
        excludedDomains: ['madrimasd.org'],
      });

      // 3. Assert
      expect(store.config.excludedDomains).toEqual(['madrimasd.org']);
      expect(store.config.skipIfEmpty).toBe(false);
    });
  });

  describe('10. Fallo de extraccion ignorado (ignoreExtractionFailure)', () => {
    it('10.1 deberia venir activo por defecto', () => {
      // 1. Arrange & 2. Act
      const store = useWebScraperStore(NODE_ID);

      // 3. Assert: replica del defecto del DTO del backend.
      expect(store.config.ignoreExtractionFailure).toBe(
        DEFAULT_SCRAPER_IGNORE_EXTRACTION_FAILURE,
      );
    });

    it('10.2 NO deberia publicarse cuando coincide con el defecto', () => {
      // 1. Arrange: al contrario que `skipIfEmpty`, esta bandera no tiene
      //    consecuencia topologica, de modo que vale el criterio general de no
      //    engordar el esquema con lo que el defecto ya dice.
      const store = buildConfiguredStore();

      // 2. Act
      const params = store.toNodeParams();

      // 3. Assert
      expect(params.ignoreExtractionFailure).toBeUndefined();
    });

    it('10.3 deberia publicarse cuando el operador la apaga', () => {
      // 1. Arrange: apagarla es una decision —"quiero que esto pause"— y tiene
      //    que quedar escrita en el esquema para ser auditable.
      const store = buildConfiguredStore();

      // 2. Act
      store.updateConfig({ ignoreExtractionFailure: false });
      const params = store.toNodeParams();

      // 3. Assert
      expect(params.ignoreExtractionFailure).toBe(false);
    });

    it('10.4 NO deberia influir en isConfigValid', () => {
      // 1. Arrange: un booleano con defecto siempre es valido; no hay forma de
      //    teclearlo mal.
      const store = buildConfiguredStore();

      // 2. Act
      store.updateConfig({ ignoreExtractionFailure: false });

      // 3. Assert
      expect(store.isConfigValid).toBe(true);
    });

    it('10.5 deberia restaurarse al hidratar desde el esquema', () => {
      // 1. Arrange: sin esto el operador reabre un flujo que SI pausaba y ve el
      //    toggle encendido, que es exactamente lo contrario de lo guardado.
      const store = useWebScraperStore(NODE_ID);

      // 2. Act
      store.hydrateFromNode({
        outputNamespace: 'scraped_web',
        params: { ignoreExtractionFailure: false },
      });

      // 3. Assert
      expect(store.config.ignoreExtractionFailure).toBe(false);
    });

    it('10.6 deberia caer al defecto si el esquema no la trae', () => {
      // 1. Arrange: todo flujo guardado ANTES de que existiera la bandera. La
      //    lectura defensiva es lo que impide que se hidrate como `undefined`.
      const store = useWebScraperStore(NODE_ID);

      // 2. Act
      store.hydrateFromNode({ outputNamespace: 'scraped_web', params: {} });

      // 3. Assert
      expect(store.config.ignoreExtractionFailure).toBe(true);
    });
  });
});
