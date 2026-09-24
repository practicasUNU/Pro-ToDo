import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { createMockStatePayloadContext } from '@test/factories/state-payload-context.factory';

import {
  ERR_ACCESS_DENIED_BLOCK_DETECTED,
  ERR_SCRAPER_CONFIG,
  ERR_SCRAPER_URL_MALFORMED,
  ERR_SCRAPER_URL_UNRESOLVED,
  WebScraperStrategy,
} from './web-scraper.strategy';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type {
  ScrapeOutcome,
  WebScraperRunner,
} from '@modules/nodes/services/web-scraper.runner';

const TARGET_URL = 'https://diario.example/nota-de-prensa';

/**
 * Lo que el nodo declara en su `pipeline_schema`.
 *
 * Desde que `targetUrl` lleva `@Matches(INTERPOLATION_ONLY_PATTERN)`, una URL
 * literal ya no supera el DTO: todo extractor debe nombrar el namespace del que
 * sale su enlace, que es lo que permite a la regla 7 de la topologia juzgar su
 * posicion en el grafo. Por eso los casos que antes pasaban `TARGET_URL` a
 * secas pasan ahora la plantilla, y resuelven contra el contexto.
 */
const TARGET_TEMPLATE = '{{parsed_email.extracted_urls[0]}}';

/** Desenlace exitoso del runner, que es lo unico que la estrategia traduce. */
const successOutcome = (
  overrides: Partial<ScrapeOutcome> = {},
): ScrapeOutcome =>
  ({
    success: true,
    sourceUrl: TARGET_URL,
    article: {
      title: 'Titular de la nota',
      byline: null,
      content: 'Primer parrafo.\n\nSegundo parrafo.',
    },
    attempts: 1,
    ...overrides,
  }) as ScrapeOutcome;

/**
 * Doble del runner. La estrategia ya NO navega: su trabajo es validar `params`,
 * resolver la URL contra el contexto y traducir el desenlace a `NodeResult`, y
 * eso es lo unico que estas pruebas examinan. La navegacion tiene su propio
 * spec en `web-scraper.runner.spec.ts`.
 */
const createHarness = (
  outcome: ScrapeOutcome = successOutcome(),
): { strategy: WebScraperStrategy; run: jest.Mock } => {
  const run = jest.fn().mockResolvedValue(outcome);
  const strategy = new WebScraperStrategy({
    run,
  } as unknown as WebScraperRunner);

  return { strategy, run };
};

const buildContext = (
  namespaces: Record<string, Record<string, unknown>> = {},
): StatePayloadContext =>
  createMockStatePayloadContext({ currentStep: 'extractor_web', namespaces });

/** Contexto con el enlace ya puesto donde `TARGET_TEMPLATE` lo busca. */
const contextWithUrl = (url: string = TARGET_URL): StatePayloadContext =>
  buildContext({ parsed_email: { extracted_urls: [url] } });

describe('WebScraperStrategy', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('0. Identidad del nodo', () => {
    it('0.1 deberia declararse como el nodo EXTRACTOR_WEB', () => {
      // 1. Arrange & 2. Act
      const { strategy } = createHarness();

      // 3. Assert: la factoria indexa por este valor.
      expect(strategy.nodeType).toBe(NodeType.EXTRACTOR_WEB);
    });
  });

  describe('1. Validacion de configuracion', () => {
    it('1.1 deberia fallar como GRAVE si falta targetUrl', async () => {
      // 1. Arrange
      const { strategy, run } = createHarness();

      // 2. Act
      const result = await strategy.execute(buildContext(), {});

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_SCRAPER_CONFIG);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.missingFields).toContain('targetUrl');
      expect(run).not.toHaveBeenCalled();
    });

    it('1.2 deberia rechazar un timeoutMs por debajo del suelo', async () => {
      // 1. Arrange
      const { strategy } = createHarness();

      // 2. Act
      const result = await strategy.execute(contextWithUrl(), {
        targetUrl: TARGET_TEMPLATE,
        timeoutMs: 100,
      });

      // 3. Assert
      expect(result.error?.code).toBe(ERR_SCRAPER_CONFIG);
      expect(result.error?.missingFields).toContain('timeoutMs');
    });

    it('1.3 deberia rechazar claves no declaradas en el DTO', async () => {
      // 1. Arrange
      const { strategy } = createHarness();

      // 2. Act: `forbidNonWhitelisted` evita que un "selecctor" mal escrito se
      //    ignore en silencio y el nodo corra con una configuracion que nadie pidio.
      const result = await strategy.execute(contextWithUrl(), {
        targetUrl: TARGET_TEMPLATE,
        selector: 'article',
      });

      // 3. Assert
      expect(result.error?.code).toBe(ERR_SCRAPER_CONFIG);
    });

    it('1.5 deberia rechazar una URL literal', async () => {
      // 1. Arrange
      const { strategy, run } = createHarness();

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
      });

      // 3. Assert: el motivo no es de formato —esa URL es perfectamente
      //    navegable— sino topologico: un literal no nombra ningun namespace,
      //    de modo que este nodo no declararia dependencia alguna y la regla 7
      //    del validador de topologia se quedaria sin nada que comprobar.
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_SCRAPER_CONFIG);
      expect(result.error?.missingFields).toContain('targetUrl');
      expect(run).not.toHaveBeenCalled();
    });

    it('1.6 deberia rechazar una URL que solo CONTIENE una marca', async () => {
      // 1. Arrange
      const { strategy, run } = createHarness();

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        targetUrl: 'https://otro-portal.es/?x={{parsed_email.subject}}',
      });

      // 3. Assert: es lo que cubre el anclaje de `INTERPOLATION_ONLY_PATTERN`.
      //    Sin `^...$` esto pasaria el filtro y seria un literal disfrazado: el
      //    destino real lo fija quien escribio el esquema, no el correo.
      expect(result.error?.code).toBe(ERR_SCRAPER_CONFIG);
      expect(run).not.toHaveBeenCalled();
    });

    it('1.4 deberia pasar al runner los valores por defecto del DTO', async () => {
      // 1. Arrange
      const { strategy, run } = createHarness();

      // 2. Act
      await strategy.execute(contextWithUrl(), {
        targetUrl: TARGET_TEMPLATE,
      });

      // 3. Assert
      const [, options] = run.mock.calls[0] as [URL, Record<string, number>];

      expect(options).toEqual({
        timeoutMs: 20_000,
        maxRetries: 2,
        retryDelayMs: 2_000,
      });
    });
  });

  describe('2. Resolucion de la URL', () => {
    it('2.1 deberia interpolar targetUrl contra el contexto', async () => {
      // 1. Arrange: es el caso real del pipeline, con el enlace que publica
      //    PARSER_PRE_IA en `parsed_email.extracted_urls`.
      const { strategy, run } = createHarness();
      const context = buildContext({
        parsed_email: { extracted_urls: [TARGET_URL] },
      });

      // 2. Act
      const result = await strategy.execute(context, {
        targetUrl: '{{parsed_email.extracted_urls[0]}}',
      });

      // 3. Assert
      expect(result.success).toBe(true);

      const [url] = run.mock.calls[0] as [URL];

      expect(url.toString()).toBe(TARGET_URL);
    });

    it('2.2 deberia fallar como GRAVE si la variable no existe en el contexto', async () => {
      // 1. Arrange
      const { strategy, run } = createHarness();

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        targetUrl: '{{parsed_email.extracted_urls[0]}}',
      });

      // 3. Assert: `getInterpolatedValue` LANZA, y dejar salir la excepcion la
      //    normalizaria el motor a URGENTE, que `canRetry` nunca reintenta.
      expect(result.error?.code).toBe(ERR_SCRAPER_URL_UNRESOLVED);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.missingFields).toEqual([
        'parsed_email.extracted_urls[0]',
      ]);
      expect(run).not.toHaveBeenCalled();
    });

    it('2.3 deberia rechazar una cadena que no es una URL', async () => {
      // 1. Arrange: el valor malo entra por el CONTEXTO y no por los `params`.
      //    Es el unico camino que queda —el DTO ya no admite un literal— y es
      //    tambien el realista: la cadena la escribio un correo de fuera.
      const { strategy } = createHarness();

      // 2. Act
      const result = await strategy.execute(contextWithUrl('no-es-una-url'), {
        targetUrl: TARGET_TEMPLATE,
      });

      // 3. Assert
      expect(result.error?.code).toBe(ERR_SCRAPER_URL_MALFORMED);
    });

    it('2.4 deberia rechazar un esquema distinto de http o https', async () => {
      // 1. Arrange
      const { strategy, run } = createHarness();

      // 2. Act
      const result = await strategy.execute(
        contextWithUrl('file:///etc/passwd'),
        { targetUrl: TARGET_TEMPLATE },
      );

      // 3. Assert: la URL viene interpolada de un correo EXTERNO; sin la lista
      //    blanca de esquemas, un `file:` seria una lectura arbitraria del disco
      //    del servidor disparada desde fuera.
      expect(result.error?.code).toBe(ERR_SCRAPER_URL_MALFORMED);
      expect(run).not.toHaveBeenCalled();
    });
  });

  describe('3. Traduccion del desenlace a NodeResult', () => {
    it('3.1 deberia publicar el esquema completo de scraped_web', async () => {
      // 1. Arrange
      const { strategy } = createHarness();

      // 2. Act
      const result = await strategy.execute(contextWithUrl(), {
        targetUrl: TARGET_TEMPLATE,
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
      expect(result.data?.byline).toBeNull();
      expect(typeof result.data?.scraped_at).toBe('string');
    });

    it('3.2 deberia publicar la URL FINAL que devuelve el runner', async () => {
      // 1. Arrange
      const finalUrl = 'https://diario.example/2026/nota-ampliada';
      const { strategy } = createHarness(
        successOutcome({ sourceUrl: finalUrl }),
      );

      // 2. Act
      const result = await strategy.execute(contextWithUrl(), {
        targetUrl: TARGET_TEMPLATE,
      });

      // 3. Assert
      expect(result.data?.source_url).toBe(finalUrl);
    });

    it('3.3 deberia traducir un fallo del runner a GRAVE con su codigo', async () => {
      // 1. Arrange
      const { strategy } = createHarness({
        success: false,
        code: ERR_ACCESS_DENIED_BLOCK_DETECTED,
        message: 'Acceso denegado: muro de pago.',
        attempts: 1,
      });

      // 2. Act
      const result = await strategy.execute(contextWithUrl(), {
        targetUrl: TARGET_TEMPLATE,
      });

      // 3. Assert: el codigo viaja intacto porque es contra lo que compara el
      //    `catchErrors` de un esquema; reescribirlo aqui romperia esas rutas.
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_ACCESS_DENIED_BLOCK_DETECTED);
      expect(result.error?.level).toBe('GRAVE');
    });

    it('3.4 deberia propagar la traza del runner cuando la trae', async () => {
      // 1. Arrange
      const { strategy } = createHarness({
        success: false,
        code: ERR_ACCESS_DENIED_BLOCK_DETECTED,
        message: 'fallo',
        stackTrace: 'Error: fallo\n  at algun.sitio',
        attempts: 3,
      });

      // 2. Act
      const result = await strategy.execute(contextWithUrl(), {
        targetUrl: TARGET_TEMPLATE,
      });

      // 3. Assert: el protocolo de resiliencia la vuelca al `.log` fisico.
      expect(result.error?.stackTrace).toContain('at algun.sitio');
    });
  });

  describe('4. Inmutabilidad del contexto', () => {
    it('4.1 no deberia escribir en el contexto que recibe', async () => {
      // 1. Arrange
      const { strategy } = createHarness();
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

  describe('5. Namespaces requeridos', () => {
    it('5.1 deberia extraer la raiz de la plantilla de targetUrl', () => {
      // 1. Arrange & 2. Act
      const { strategy } = createHarness();

      // 3. Assert: es lo que el motor comprueba ANTES de invocar el nodo. Se
      //    declara el NAMESPACE, no la ruta completa: la pregunta es "corrio el
      //    parser", no "trae ese indice del arreglo".
      expect(
        strategy.getRequiredNamespaces({
          targetUrl: '{{parsed_email.extracted_urls[0]}}',
        }),
      ).toEqual(['parsed_email']);
    });

    it('5.2 no deberia declarar nada ante una URL literal', () => {
      // 1. Arrange & 2. Act
      const { strategy } = createHarness();

      // 3. Assert: se devuelve VACIO, y ese es el cambio. Antes caia a un
      //    `FALLBACK_SCRAPER_NAMESPACE = 'parsed_email'` para que ningun
      //    extractor quedara sin dependencias declaradas, pero era una
      //    SUPOSICION: este `targetUrl` no menciona `parsed_email` por ningun
      //    lado, y el operador leia una acusacion sobre un namespace que su
      //    esquema nunca cito.
      //
      //    La garantia no se ha perdido, ha cambiado de sitio y de pregunta: la
      //    sostiene `requiredUpstreamFieldTypes` a traves de la regla 8, que
      //    comprueba que haya DE DONDE sacar una URL en vez de adivinar de
      //    cual. Y a una URL literal la sigue rechazando el `@Matches` del DTO
      //    (ver 1.5), que es quien da el mensaje correcto.
      expect(strategy.getRequiredNamespaces({ targetUrl: TARGET_URL })).toEqual(
        [],
      );
    });

    it('5.3 no deberia duplicar un namespace citado dos veces', () => {
      // 1. Arrange & 2. Act
      const { strategy } = createHarness();

      // 3. Assert
      expect(
        strategy.getRequiredNamespaces({
          targetUrl:
            '{{parsed_email.base_url}}/{{parsed_email.extracted_urls[0]}}',
        }),
      ).toEqual(['parsed_email']);
    });

    it('5.4 no deberia declarar nada si targetUrl falta o no es una cadena', () => {
      // 1. Arrange & 2. Act: validar el DTO es competencia de `execute`; aqui
      //    adelantarlo daria dos mensajes para el mismo error.
      const { strategy } = createHarness();

      // 3. Assert: `params: {}` es exactamente lo que trae una PLANTILLA de
      //    flujo, que declara topologia y elige los valores despues. Inventarle
      //    una dependencia la hacia irrepresentable: ninguna plantilla podia
      //    contener un EXTRACTOR_WEB.
      expect(strategy.getRequiredNamespaces({})).toEqual([]);
      expect(strategy.getRequiredNamespaces({ targetUrl: '' })).toEqual([]);
      expect(strategy.getRequiredNamespaces({ targetUrl: 42 })).toEqual([]);
    });

    it('5.5 deberia leer el namespace de una plantilla compuesta', () => {
      // 1. Arrange & 2. Act: una plantilla COMPUESTA no casa el patron anclado
      //    del DTO, pero declara perfectamente de quien depende.
      const { strategy } = createHarness();

      // 3. Assert: se lee lo que la plantilla DICE, no lo que casa el patron
      //    anclado. Sustituir esto por un `INTERPOLATION_ONLY_PATTERN.test()`
      //    dejaria este `targetUrl` sin dependencias y mandaria al operador a
      //    anadir un nodo que este flujo no necesita.
      expect(
        strategy.getRequiredNamespaces({
          targetUrl: '{{llm_response.base_url}}/{{llm_response.slug}}',
        }),
      ).toEqual(['llm_response']);
    });
  });

  describe('6. Contrato de configurabilidad y completitud', () => {
    it('6.1 deberia declarar que solo puede apuntar a campos de tipo URL', () => {
      // 1. Arrange & 2. Act
      const { strategy } = createHarness();

      // 3. Assert: es lo que la regla 8 del validador de topologia consulta
      //    para exigir que algun paso anterior publique una fuente de enlaces.
      expect(strategy.requiredUpstreamFieldTypes).toEqual(['url', 'url[]']);
    });

    it('6.2 deberia declarar incompleto un nodo sin targetUrl', () => {
      // 1. Arrange & 2. Act
      const { strategy } = createHarness();

      // 3. Assert: guardar y activar son dos exigencias distintas. El esquema se
      //    persiste asi —es un borrador, y una plantilla ni siquiera trae
      //    operativa—, pero `assertActivatable` lo frena antes de habilitarlo.
      expect(strategy.getIncompleteParams({})).toEqual(['targetUrl']);
      expect(strategy.getIncompleteParams({ targetUrl: '' })).toEqual([
        'targetUrl',
      ]);
      expect(strategy.getIncompleteParams({ targetUrl: '   ' })).toEqual([
        'targetUrl',
      ]);
    });

    it('6.3 deberia dar por completo un nodo con targetUrl elegido', () => {
      // 1. Arrange & 2. Act
      const { strategy } = createHarness();

      // 3. Assert
      expect(
        strategy.getIncompleteParams({
          targetUrl: '{{parsed_email.extracted_urls[0]}}',
        }),
      ).toEqual([]);
    });

    it('6.4 deberia fallar al ejecutarse sin targetUrl, con codigo de config', async () => {
      // 1. Arrange: el DTO admite la ausencia para que una plantilla exista, asi
      //    que este camino es alcanzable si alguien activa por SQL directo.
      const { strategy } = createHarness();
      const context = createMockStatePayloadContext({
        executionId: 'exec-sin-url',
        currentStep: 'nodo_extractor',
        namespaces: {},
      });

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert: se nombra el problema real en vez de dejar que `new URL('')`
      //    reviente mas abajo como un fallo de FORMATO, que mandaria a revisar
      //    una URL que nadie escribio.
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_SCRAPER_CONFIG);
      expect(result.error?.missingFields).toEqual(['targetUrl']);
    });
  });
});
