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

/**
 * Las cinco claves en blanco que publica cualquier camino de omision.
 *
 * `scraped_at` se compara aparte porque es una marca de tiempo viva.
 */
const NEUTRAL_PAYLOAD = {
  source_url: null,
  article_title: '',
  full_article_content: '',
  byline: null,
  character_count: 0,
  status: 'SKIPPED_EMPTY',
};

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

/**
 * URL que el doble del runner recibio en su primera invocacion.
 *
 * El `mock.calls` de un `jest.Mock` sin genericos es `any[][]`, y leer de el a
 * pelo dispara `no-unsafe-member-access`. Se tipa UNA vez aqui en vez de repetir
 * el casteo en cada aserto.
 */
const firstNavigatedUrl = (run: jest.Mock): string | undefined => {
  const calls = run.mock.calls as readonly (readonly [URL, unknown])[];

  return calls[0]?.[0].href;
};

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
    it('1.1 deberia fallar como GRAVE si falta targetUrl y no es omitible', async () => {
      // 1. Arrange 📐: `skipIfEmpty: false` explicito. Con el defecto (`true`)
      //    la ausencia de origen es una DECISION declarada y no un fallo; ver
      //    el bloque 7.
      const { strategy, run } = createHarness();

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        skipIfEmpty: false,
      });

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
        maxRetries: 3,
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

    it('2.2 deberia SALTARSE el nodo si la lista de enlaces viene vacia', async () => {
      // 1. Arrange 📐: es el estado normal de un correo sin enlaces, y desde que
      //    existe el rescate por OCR es ademas el frecuente —la transcripcion de
      //    un escaneo rara vez trae URLs—. Fallar aqui rompia el flujo justo
      //    despues de haberlo rescatado.
      const { strategy, run } = createHarness();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        targetUrl: '{{parsed_email.extracted_urls[0]}}',
      });

      // 3. Assert 🎯: exito VACIO, no fallo. El nodo de IA que va detras se
      //    queda con el texto que ya tenia, y nadie tiene que cerrar a mano una
      //    incidencia por un correo que simplemente no llevaba enlaces.
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject(NEUTRAL_PAYLOAD);
      expect(typeof result.data?.scraped_at).toBe('string');
      expect(run).not.toHaveBeenCalled();
    });

    it('2.2bis deberia seguir fallando GRAVE ante una variable ESCALAR ausente', async () => {
      // 1. Arrange 📐: la otra mitad de la distincion. Un `targetUrl` que apunta
      //    a un namespace que nadie escribe es un flujo mal compuesto, y
      //    degradarlo silenciaria un error de diseno en vez de mostrarlo.
      const { strategy, run } = createHarness();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        targetUrl: '{{parsed_email.enlace_principal}}',
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_SCRAPER_URL_UNRESOLVED);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.missingFields).toEqual([
        'parsed_email.enlace_principal',
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
        'character_count',
        'full_article_content',
        'scraped_at',
        'source_url',
        'status',
      ]);
      expect(result.data?.source_url).toBe(TARGET_URL);
      expect(result.data?.article_title).toBe('Titular de la nota');
      expect(result.data?.byline).toBeNull();
      expect(typeof result.data?.scraped_at).toBe('string');
      expect(result.data?.status).toBe('OK');
      expect(result.data?.character_count).toBe(
        (result.data?.full_article_content as string).length,
      );
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

      // 2. Act: `ignoreExtractionFailure: false` explicito. El defecto es
      //    `true`, de modo que sin esto el fallo se traduciria al payload
      //    neutro y no habria GRAVE que comprobar. Lo cubre 3.5.
      const result = await strategy.execute(contextWithUrl(), {
        targetUrl: TARGET_TEMPLATE,
        ignoreExtractionFailure: false,
      });

      // 3. Assert: el codigo viaja intacto porque es contra lo que compara el
      //    `catchErrors` de un esquema; reescribirlo aqui romperia esas rutas.
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_ACCESS_DENIED_BLOCK_DETECTED);
      expect(result.error?.level).toBe('GRAVE');

      // El presupuesto agotado es un hecho APARTE del codigo: sin esta marca el
      // motor reintentaria el nodo entero —GRAVE es la severidad que `canRetry`
      // acepta— y repetiria la navegacion que el runner ya repitio.
      expect(result.error?.metadata).toMatchObject({ exhausted: true });
      expect(typeof result.error?.metadata?.maxRetries).toBe('number');
      expect(result.error?.description).toContain('Causa raiz');
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
        ignoreExtractionFailure: false,
      });

      // 3. Assert: el protocolo de resiliencia la vuelca al `.log` fisico.
      expect(result.error?.stackTrace).toContain('at algun.sitio');
    });

    it('3.5 deberia devolver FALLBACK_EMPTY ante un fallo del runner por defecto', async () => {
      // 1. Arrange 📐: el defecto de `ignoreExtractionFailure` es `true`, asi que
      //    el muro anti-bot deja de pausar la FSM. Es la razon de ser del flag:
      //    el fallo es de un tercero y transitorio, y convertirlo en una
      //    incidencia que alguien cierra a mano cuesta mas que seguir con el
      //    cuerpo vacio.
      const { strategy } = createHarness({
        success: false,
        code: ERR_ACCESS_DENIED_BLOCK_DETECTED,
        message: 'Acceso denegado: muro de pago.',
        attempts: 1,
      });

      // 2. Act ⚙️
      const result = await strategy.execute(contextWithUrl(), {
        targetUrl: TARGET_TEMPLATE,
      });

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.data?.status).toBe('FALLBACK_EMPTY');
      expect(result.data?.full_article_content).toBe('');
      expect(result.data?.character_count).toBe(0);
    });

    it('3.6 deberia conservar la URL intentada en el fallback', async () => {
      // 1. Arrange 📐: sin `source_url` la traza pierde el unico dato que
      //    permite reproducir el fallo contra el portal, y el FALLBACK_EMPTY
      //    seria indistinguible de un SKIPPED_EMPTY al leer el checkpoint.
      const { strategy } = createHarness({
        success: false,
        code: ERR_ACCESS_DENIED_BLOCK_DETECTED,
        message: 'Acceso denegado.',
        attempts: 1,
      });

      // 2. Act ⚙️
      const result = await strategy.execute(contextWithUrl(), {
        targetUrl: TARGET_TEMPLATE,
      });

      // 3. Assert 🎯
      expect(result.data?.source_url).toBe(TARGET_URL);
    });

    it('3.7 deberia publicar el esquema COMPLETO tambien en el fallback', async () => {
      // 1. Arrange 📐: un nodo posterior que interpole
      //    `{{scraped_web.article_title}}` recibiria un
      //    `MissingContextVariableException` por una clave que el contrato
      //    promete. Un campo declarado y ausente es indistinguible de un flujo
      //    mal compuesto.
      const { strategy } = createHarness({
        success: false,
        code: ERR_ACCESS_DENIED_BLOCK_DETECTED,
        message: 'Acceso denegado.',
        attempts: 1,
      });

      // 2. Act ⚙️
      const result = await strategy.execute(contextWithUrl(), {
        targetUrl: TARGET_TEMPLATE,
      });

      // 3. Assert 🎯
      expect(Object.keys(result.data ?? {}).sort()).toEqual([
        'article_title',
        'byline',
        'character_count',
        'full_article_content',
        'scraped_at',
        'source_url',
        'status',
      ]);
    });

    it('3.8 NO deberia silenciar un fallo de CONFIGURACION con el flag activo', async () => {
      // 1. Arrange 📐: LA FRONTERA DEL FLAG. Un `targetUrl` ausente con
      //    `skipIfEmpty: false` es un defecto del flujo, no una contingencia de
      //    red. Silenciarlo esconderia un nodo mal compuesto tras un exito
      //    vacio y PERMANENTE, que es justo lo que no se quiere.
      const { strategy } = createHarness();

      // 2. Act ⚙️
      const result = await strategy.execute(contextWithUrl(), {
        ignoreExtractionFailure: true,
        skipIfEmpty: false,
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_SCRAPER_CONFIG);
      expect(result.error?.level).toBe('GRAVE');
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

    it('6.2bis no deberia exigir targetUrl cuando el nodo es omitible', () => {
      // 1. Arrange & 2. Act
      const { strategy } = createHarness();

      // 3. Assert 🎯: un flujo de contingencia —OCR sin enlaces— tiene que
      //    poder ACTIVARSE sin origen, que es lo que `assertActivatable` mira.
      expect(strategy.getIncompleteParams({ skipIfEmpty: true })).toEqual([]);
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
      const result = await strategy.execute(context, { skipIfEmpty: false });

      // 3. Assert: se nombra el problema real en vez de dejar que `new URL('')`
      //    reviente mas abajo como un fallo de FORMATO, que mandaria a revisar
      //    una URL que nadie escribio.
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_SCRAPER_CONFIG);
      expect(result.error?.missingFields).toEqual(['targetUrl']);
    });
  });

  describe('7. Fallback neutro declarado (skipIfEmpty)', () => {
    it('7.1 deberia omitirse con exito y payload neutro sin targetUrl', async () => {
      // 1. Arrange 📐: el flujo de contingencia OCR. Nadie aguas arriba publica
      //    una URL, y el nodo lo declara en vez de romperse al llegar.
      const { strategy, run } = createHarness();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        skipIfEmpty: true,
      });

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject(NEUTRAL_PAYLOAD);
      expect(run).not.toHaveBeenCalled();
    });

    it('7.2 deberia publicar las CINCO claves que declara outputFields', async () => {
      // 1. Arrange 📐: un nodo posterior que interpole
      //    `{{scraped_web.article_title}}` recibiria un fallo de contexto si la
      //    omision dejara fuera una clave que el contrato promete.
      const { strategy } = createHarness();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        skipIfEmpty: true,
      });

      // 3. Assert 🎯
      expect(Object.keys(result.data ?? {}).sort()).toEqual(
        strategy.outputFields.map((field) => field.name).sort(),
      );
    });

    it('7.3 deberia eximir de la regla 8 solo cuando la bandera esta activa', () => {
      // 1. Arrange & 2. Act
      const { strategy } = createHarness();

      // 3. Assert 🎯: sin la bandera se conserva la garantia topologica de
      //    siempre; con ella el flujo de contingencia es expresable.
      expect(
        strategy.getRequiredUpstreamFieldTypes({ skipIfEmpty: true }),
      ).toEqual([]);
      expect(strategy.getRequiredUpstreamFieldTypes({})).toEqual([
        'url',
        'url[]',
      ]);
      expect(
        strategy.getRequiredUpstreamFieldTypes({ skipIfEmpty: false }),
      ).toEqual(['url', 'url[]']);
    });

    it('7.4 no deberia encubrir un targetUrl MAL PUESTO', async () => {
      // 1. Arrange 📐: la asimetria que sostiene el Poka-Yoke. "Omitir si no
      //    hay" no es "omitir si esta mal": un origen escalar ausente sigue
      //    siendo un flujo mal compuesto y tiene que verse.
      const { strategy, run } = createHarness();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        targetUrl: '{{parsed_email.url_unica}}',
        skipIfEmpty: true,
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_SCRAPER_URL_UNRESOLVED);
      expect(result.error?.level).toBe('GRAVE');
      expect(run).not.toHaveBeenCalled();
    });

    it('7.5 deberia rechazar un skipIfEmpty que no sea booleano', async () => {
      // 1. Arrange 📐
      const { strategy } = createHarness();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        skipIfEmpty: 'si',
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_SCRAPER_CONFIG);
      expect(result.error?.missingFields).toContain('skipIfEmpty');
    });
  });

  /**
   * El origen deja de ser una POSICION para pasar a ser un CRITERIO.
   *
   * Los correos de ingesta traen a la vez el enlace del portal institucional
   * —que es un metadato de enrutado editorial para el destino, no la noticia— y
   * el del contenido real. Cual va primero cambia de un correo al siguiente, asi
   * que ninguna posicion fija resuelve el problema; el dominio si.
   */
  describe('8. Seleccion por dominio sobre la lista de enlaces', () => {
    const LIST_TEMPLATE = '{{parsed_email.extracted_urls}}';
    const INSTITUTIONAL_URL =
      'https://www.madrimasd.org/fundacion/portal-contratante';
    const EXTERNAL_URL =
      'https://contratos-publicos.comunidad.madrid/licitacion/42';

    /** Contexto con la lista completa de enlaces del correo. */
    const contextWithUrls = (
      ...urls: readonly unknown[]
    ): StatePayloadContext =>
      buildContext({ parsed_email: { extracted_urls: urls } });

    it('8.1 deberia saltar el dominio excluido y navegar al externo', async () => {
      // 1. Arrange 📐: el institucional va PRIMERO, que es el caso que la
      //    seleccion por posicion resolvia mal.
      const { strategy, run } = createHarness();

      // 2. Act ⚙️
      const result = await strategy.execute(
        contextWithUrls(INSTITUTIONAL_URL, EXTERNAL_URL),
        { targetUrl: LIST_TEMPLATE, excludedDomains: ['madrimasd.org'] },
      );

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(run).toHaveBeenCalledTimes(1);
      expect(firstNavigatedUrl(run)).toBe(EXTERNAL_URL);
    });

    it('8.2 deberia respetar el orden de la lista cuando nada esta excluido', async () => {
      // 1. Arrange 📐: sin exclusiones, "primer elegible" es el primero a secas.
      const { strategy, run } = createHarness();

      // 2. Act ⚙️
      const result = await strategy.execute(
        contextWithUrls(EXTERNAL_URL, INSTITUTIONAL_URL),
        { targetUrl: LIST_TEMPLATE },
      );

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(firstNavigatedUrl(run)).toBe(EXTERNAL_URL);
    });

    it('8.3 deberia publicar el payload neutro si TODO esta excluido', async () => {
      // 1. Arrange 📐: el correo solo traia enlaces del portal propio.
      const { strategy, run } = createHarness();

      // 2. Act ⚙️
      const result = await strategy.execute(
        contextWithUrls(INSTITUTIONAL_URL, 'https://madrimasd.org/noticias'),
        { targetUrl: LIST_TEMPLATE, excludedDomains: ['madrimasd.org'] },
      );

      // 3. Assert 🎯: exito VACIO y no un fallo. El flujo sigue y el
      //    PROCESADOR_IA redacta con el cuerpo del correo.
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject(NEUTRAL_PAYLOAD);
      expect(result.error).toBeUndefined();
      expect(run).not.toHaveBeenCalled();
    });

    it('8.4 deberia excluir subdominios pero NO un dominio que lo contenga', async () => {
      // 1. Arrange 📐: la diferencia entre comparar sufijos y comparar
      //    subcadenas. `no-madrimasd.org.ejemplo.com` es un portal AJENO.
      const { strategy, run } = createHarness();
      const lookalike = 'https://no-madrimasd.org.ejemplo.com/nota';

      // 2. Act ⚙️: el subdominio `www.` entra por el dominio padre.
      const result = await strategy.execute(
        contextWithUrls(INSTITUTIONAL_URL, lookalike),
        { targetUrl: LIST_TEMPLATE, excludedDomains: ['madrimasd.org'] },
      );

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(firstNavigatedUrl(run)).toBe(lookalike);
    });

    it('8.5 deberia saltar entradas malformadas sin fallar', async () => {
      // 1. Arrange 📐: en modo lista, "no navegable" significa "la siguiente".
      //    Un boletin con un `mailto:` o un ancla relativa no es un fallo.
      const { strategy, run } = createHarness();

      // 2. Act ⚙️
      const result = await strategy.execute(
        contextWithUrls(
          'no-soy-una-url',
          'mailto:prensa@madrimasd.org',
          'file:///etc/passwd',
          42,
          EXTERNAL_URL,
        ),
        { targetUrl: LIST_TEMPLATE },
      );

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(firstNavigatedUrl(run)).toBe(EXTERNAL_URL);
    });

    it('8.6 deberia omitirse ante una lista vacia', async () => {
      // 1. Arrange 📐: `extracted_urls` llega siempre como arreglo, nunca
      //    ausente, asi que el correo sin enlaces se ve AQUI.
      const { strategy, run } = createHarness();

      // 2. Act ⚙️
      const result = await strategy.execute(contextWithUrls(), {
        targetUrl: LIST_TEMPLATE,
      });

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject(NEUTRAL_PAYLOAD);
      expect(run).not.toHaveBeenCalled();
    });

    it('8.7 deberia fallar GRAVE si el namespace de la lista no existe', async () => {
      // 1. Arrange 📐: la asimetria del bloque 7, aplicada al modo lista. Un
      //    `url[]` ausente no es "no habia enlaces": es un nodo que apunta a un
      //    namespace que nadie escribe.
      const { strategy, run } = createHarness();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        targetUrl: LIST_TEMPLATE,
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_SCRAPER_URL_UNRESOLVED);
      expect(result.error?.level).toBe('GRAVE');
      expect(run).not.toHaveBeenCalled();
    });

    it('8.8 deberia aplicar la exclusion tambien en modo POSICION', async () => {
      // 1. Arrange 📐: quien fija la posicion 1 y excluye el portal propio
      //    pide lo mismo —no raspar ese dominio—, y recibe el payload neutro en
      //    vez de una navegacion que nadie queria.
      const { strategy, run } = createHarness();

      // 2. Act ⚙️
      const result = await strategy.execute(
        contextWithUrls(INSTITUTIONAL_URL),
        {
          targetUrl: TARGET_TEMPLATE,
          excludedDomains: ['madrimasd.org'],
        },
      );

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject(NEUTRAL_PAYLOAD);
      expect(run).not.toHaveBeenCalled();
    });

    it('8.9 deberia comparar el dominio sin distinguir mayusculas', async () => {
      // 1. Arrange 📐: la lista la teclea una persona y `url.hostname` llega
      //    siempre en minusculas. Es lo unico que se normaliza: un espacio o un
      //    punto final los rechaza antes el DTO, con un mensaje de campo.
      const { strategy, run } = createHarness();

      // 2. Act ⚙️
      const result = await strategy.execute(
        contextWithUrls(INSTITUTIONAL_URL, EXTERNAL_URL),
        { targetUrl: LIST_TEMPLATE, excludedDomains: ['MadrimasD.ORG'] },
      );

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(firstNavigatedUrl(run)).toBe(EXTERNAL_URL);
    });

    it('8.10 deberia rechazar un dominio excluido con esquema o ruta', async () => {
      // 1. Arrange 📐: se compara contra el HOST, asi que un valor con mas
      //    partes no coincidiria nunca. Admitirlo dejaria un filtro inerte.
      const { strategy, run } = createHarness();

      // 2. Act ⚙️
      const result = await strategy.execute(contextWithUrls(EXTERNAL_URL), {
        targetUrl: LIST_TEMPLATE,
        excludedDomains: ['https://madrimasd.org/portal'],
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_SCRAPER_CONFIG);
      expect(result.error?.missingFields).toContain('excludedDomains');
      expect(run).not.toHaveBeenCalled();
    });
  });
});
