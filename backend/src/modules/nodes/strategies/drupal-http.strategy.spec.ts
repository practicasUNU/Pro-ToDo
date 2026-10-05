import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { createMockStatePayloadContext } from '@test/factories/state-payload-context.factory';

import {
  DrupalHttpConfigDto,
  DrupalOperationMode,
} from '../dto/drupal-http-config.dto';

import {
  DrupalHttpStrategy,
  ERR_DRUPAL_AUTH,
  ERR_DRUPAL_CONFIG,
  ERR_DRUPAL_DOM_TARGET,
  ERR_DRUPAL_MISSING_PAYLOAD,
  ERR_DRUPAL_NETWORK,
  ERR_DRUPAL_REQUEST,
  ERR_DRUPAL_SERVER,
  TRANSFER_PARTIAL_OPERATION,
} from './drupal-http.strategy';

import type { DrupalApiConfig } from '@core/config/drupal-api.config';
import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type { NodeErrorDetail } from '@core/fsm/types/node-strategy.types';
import type { HttpClientService } from '@core/http/http-client.service';
import type { AxiosRequestConfig } from 'axios';

/**
 * Suite del CONTRATO con Drupal, no de la API de Drupal.
 *
 * Lo que aqui se fija es la forma exacta de lo que sale por el cable —ruta,
 * verbo, cabeceras y cuerpo JSON:API— y el reparto de codigos de fallo. Es un
 * contrato con un servicio externo que una prueba unitaria no puede ejercitar,
 * y el unico punto donde un cambio silencioso —un `data.id` perdido en un
 * PATCH, un nivel degradado a LEVE— se detecta antes de produccion.
 *
 * El cliente HTTP va MOCKEADO, al contrario que el renderer en la suite del
 * escudo: aqui el colaborador no es puro, es la red.
 */

const BASE_URL = 'https://drupal.example/jsonapi';
const TOKEN = 'token-de-prueba';
const API_USER = 'editor_api';

/**
 * Cabecera que emite `DrupalApiConfig.authHeader` en modo BASIC con las dos
 * constantes de arriba. Se fija como literal y no se recalcula con `Buffer`
 * para que la prueba falle si alguien cambia el formato de la cabecera: un
 * valor derivado del mismo codigo que se esta probando no prueba nada.
 */
const BASIC_AUTH_HEADER = 'Basic ZWRpdG9yX2FwaTp0b2tlbi1kZS1wcnVlYmE=';

const SOURCE_NAMESPACE = 'validated_drupal_json';
const SOURCE_FIELD = 'validated_markup';

const MARKUP = '<h1 class="titular">Innovacion en Madrid</h1>';

const PAGE_UUID = '7f1700bf-b54b-4c12-b71a-8a71f1f0ee38';
const CLOSED_UUID = 'b17d69d8-6998-4883-b8dc-153b55dbd9c5';

const EXPEDIENTE = '[data-expediente="S_2026_015"]';
const BLOCK =
  '<div data-expediente="S_2026_015"><p>Licitacion abierta</p></div>';
const OTHER_BLOCK = '<div data-expediente="S_2026_001"><p>Otra</p></div>';

/** Doble del cliente HTTP, acotado al unico metodo que la estrategia invoca. */
type HttpMock = jest.Mocked<Pick<HttpClientService, 'requestWithStatus'>>;

const buildHttpMock = (): HttpMock => ({ requestWithStatus: jest.fn() });

/** Config del entorno con credenciales utiles, salvo que se diga lo contrario. */
const buildApiConfig = (token: string = TOKEN): DrupalApiConfig =>
  ({
    baseUrl: BASE_URL,
    token,
    user: API_USER,
    authType: 'BASIC',
    // La estrategia nunca compone la cabecera: la pide ya hecha. El doble la
    // sirve como literal, igual que el getter real.
    authHeader: token.length > 0 ? BASIC_AUTH_HEADER : `Bearer ${token}`,
    timeoutMs: 15_000,
    isUsable: token.length > 0,
  }) as DrupalApiConfig;

const buildStrategy = (
  httpClient: HttpMock,
  apiConfig: DrupalApiConfig = buildApiConfig(),
): DrupalHttpStrategy =>
  new DrupalHttpStrategy(httpClient as unknown as HttpClientService, apiConfig);

const buildContext = (
  namespaces: Record<string, Record<string, unknown>> = {
    [SOURCE_NAMESPACE]: { [SOURCE_FIELD]: MARKUP },
  },
): StatePayloadContext =>
  createMockStatePayloadContext({ currentStep: 'destino_drupal', namespaces });

/** Respuesta de una entidad JSON:API con los atributos indicados. */
const entityResponse = (
  attributes: Record<string, unknown> = {},
  id = PAGE_UUID,
): { data: unknown; status: number } => ({
  data: { data: { id, attributes } },
  status: 200,
});

/** Respuesta de una pagina agregadora con el HTML dado en `body.value`. */
const pageResponse = (
  html: string,
  id = PAGE_UUID,
  nid = 55_937,
): { data: unknown; status: number } =>
  entityResponse(
    {
      drupal_internal__nid: nid,
      path: { alias: '/prueba-licitaciones' },
      body: { value: html, format: 'full_html' },
      changed: '2026-10-05T10:00:00+00:00',
    },
    id,
  );

/** Fallo del cliente HTTP con el estado indicado. */
const httpFailure = (
  status?: number,
): { failure: NodeErrorDetail; status?: number } => ({
  failure: {
    level: 'GRAVE',
    code: 'ERR_HTTP_CLIENT_REJECTED',
    message: `el remoto respondio ${status ?? 'nada'}`,
  },
  ...(status === undefined ? {} : { status }),
});

/** Config de la llamada numero `index` que recibio el cliente. */
const callConfig = (httpClient: HttpMock, index: number): AxiosRequestConfig =>
  httpClient.requestWithStatus.mock.calls[index]?.[0];

/** Cuerpo JSON:API de esa misma llamada. */
const callBody = (
  httpClient: HttpMock,
  index: number,
): Record<string, Record<string, unknown>> =>
  callConfig(httpClient, index).data as Record<string, Record<string, unknown>>;

describe('DrupalHttpStrategy', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('0. Identidad y contratos declarativos', () => {
    it('0.1 deberia declararse como el destino DESTINO_DRUPAL', () => {
      // 1. Arrange 📐: el tipo se llamo DESTINO_HTTP entre las migraciones 005
      //    y 027; el valor vigente nombra el destino, no el transporte.
      //    La clase conserva el nombre comercial, el enum no.
      const strategy = buildStrategy(buildHttpMock());

      // 3. Assert 🎯
      expect(strategy.nodeType).toBe(NodeType.DESTINO_DRUPAL);
    });

    it('0.2 deberia someter sus params a validacion estricta al guardar', () => {
      const strategy = buildStrategy(buildHttpMock());

      expect(strategy.paramsSchema).toBe(DrupalHttpConfigDto);
    });

    it('0.3 deberia exigir el namespace de origen en CREATE_NODE', () => {
      const strategy = buildStrategy(buildHttpMock());

      expect(
        strategy.getRequiredNamespaces({
          operationMode: DrupalOperationMode.CREATE_NODE,
          titleTemplate: '{{llm_response.headline}}',
        }),
      ).toEqual(expect.arrayContaining(['llm_response', SOURCE_NAMESPACE]));
    });

    it('0.4 NO deberia exigir ningun namespace en TRANSFER_HTML_BLOCK', () => {
      // 1. Arrange 📐: el bloque se extrae del DOM REMOTO, no del contexto.
      //    Exigir `validated_drupal_json` haria que la regla 7 del validador
      //    rechazara al guardar un cierre de licitacion perfectamente valido.
      const strategy = buildStrategy(buildHttpMock());

      // 3. Assert 🎯
      expect(
        strategy.getRequiredNamespaces({
          operationMode: DrupalOperationMode.TRANSFER_HTML_BLOCK,
        }),
      ).toEqual([]);
    });

    it('0.5 deberia exigir el namespace de adjuntos en UPLOAD_ATTACHMENT', () => {
      const strategy = buildStrategy(buildHttpMock());

      expect(
        strategy.getRequiredNamespaces({
          operationMode: DrupalOperationMode.UPLOAD_ATTACHMENT,
        }),
      ).toEqual(['raw_email']);
    });

    it('0.6 deberia reclamar los tres params del traslado', () => {
      const strategy = buildStrategy(buildHttpMock());

      expect(
        strategy.getIncompleteParams({
          operationMode: DrupalOperationMode.TRANSFER_HTML_BLOCK,
        }),
      ).toEqual(['targetNodeUuid', 'destinationNodeUuid', 'itemSelector']);
    });

    it('0.7 deberia dar por completo un CREATE_NODE con titulo declarado', () => {
      const strategy = buildStrategy(buildHttpMock());

      expect(
        strategy.getIncompleteParams({
          operationMode: DrupalOperationMode.CREATE_NODE,
          titleTemplate: '{{llm_response.headline}}',
        }),
      ).toEqual([]);
    });

    it('0.8 deberia declarar ERR_DRUPAL_DOM_TARGET inalcanzable sin DOM', () => {
      // 1. Arrange 📐: una ruta de recuperacion contra un codigo que el nodo no
      //    puede emitir es un nodo de respaldo que jamas corre, y el sintoma es
      //    mudo. La regla 10 del validador lo rechaza al guardar gracias a esto.
      const strategy = buildStrategy(buildHttpMock());

      // 3. Assert 🎯
      expect(
        strategy.getUnreachableErrorCodes({
          operationMode: DrupalOperationMode.CREATE_NODE,
        }),
      ).toEqual([ERR_DRUPAL_DOM_TARGET]);
      expect(
        strategy.getUnreachableErrorCodes({
          operationMode: DrupalOperationMode.APPEND_HTML_BLOCK,
        }),
      ).toEqual([]);
    });
  });

  describe('1. CREATE_NODE', () => {
    it('1.1 deberia hacer POST a la coleccion derivada del bundle', async () => {
      // 1. Arrange 📐: `node--noticias` es a la vez el `data.type` y la ruta.
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus.mockResolvedValue(
        entityResponse({ drupal_internal__nid: 42 }, 'uuid-nuevo'),
      );
      const strategy = buildStrategy(httpClient);

      // 2. Act ⚙️
      await strategy.execute(buildContext(), {
        titleTemplate: 'Titular fijo',
      });

      // 3. Assert 🎯
      expect(callConfig(httpClient, 0).url).toBe(`${BASE_URL}/node/noticias`);
      expect(callConfig(httpClient, 0).method).toBe('POST');
      expect(callConfig(httpClient, 0).headers).toMatchObject({
        Authorization: BASIC_AUTH_HEADER,
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
      });
    });

    it('1.2 deberia armar el cuerpo JSON:API con el markup del escudo', async () => {
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus.mockResolvedValue(entityResponse());
      const strategy = buildStrategy(httpClient);

      await strategy.execute(buildContext(), { titleTemplate: 'Titular fijo' });

      expect(callBody(httpClient, 0)).toEqual({
        data: {
          type: 'node--noticias',
          attributes: {
            title: 'Titular fijo',
            body: { value: MARKUP, format: 'full_html' },
            status: true,
          },
        },
      });
    });

    it('1.3 deberia interpolar el titulo contra el contexto', async () => {
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus.mockResolvedValue(entityResponse());
      const strategy = buildStrategy(httpClient);

      await strategy.execute(
        buildContext({
          [SOURCE_NAMESPACE]: { [SOURCE_FIELD]: MARKUP },
          llm_response: { headline: 'Innovacion en Madrid' },
        }),
        { titleTemplate: '{{llm_response.headline}}' },
      );

      expect(callBody(httpClient, 0).data?.attributes).toMatchObject({
        title: 'Innovacion en Madrid',
      });
    });

    it('1.4 deberia OMITIR field_resumen cuando no hay plantilla de resumen', async () => {
      // 1. Arrange 📐: un atributo que el bundle no declara provoca un 422, asi
      //    que mandarlo vacio «por si acaso» romperia los bundles sin resumen.
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus.mockResolvedValue(entityResponse());
      const strategy = buildStrategy(httpClient);

      // 2. Act ⚙️
      await strategy.execute(buildContext(), { titleTemplate: 'Titular' });

      // 3. Assert 🎯
      expect(callBody(httpClient, 0).data?.attributes).not.toHaveProperty(
        'field_resumen',
      );
    });

    it('1.5 NO deberia reintentar el POST', async () => {
      // 1. Arrange 📐: un POST repetido tras un 5xx que SI se aplico crea una
      //    segunda noticia. La idempotencia no la da el verbo.
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus.mockResolvedValue(entityResponse());
      const strategy = buildStrategy(httpClient);

      // 2. Act ⚙️
      await strategy.execute(buildContext(), { titleTemplate: 'Titular' });

      // 3. Assert 🎯
      expect(httpClient.requestWithStatus.mock.calls[0]?.[1]).toMatchObject({
        maxRetries: 0,
      });
    });

    it('1.6 deberia publicar el UUID, el nid y el alias que devuelve Drupal', async () => {
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus.mockResolvedValue(
        entityResponse(
          {
            drupal_internal__nid: 55_940,
            path: { alias: '/noticias/innovacion' },
            changed: '2026-10-05T12:00:00+00:00',
          },
          'uuid-creado',
        ),
      );
      const strategy = buildStrategy(httpClient);

      const result = await strategy.execute(buildContext(), {
        titleTemplate: 'Titular',
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        node_id: 'uuid-creado',
        drupal_internal__nid: 55_940,
        path_alias: '/noticias/innovacion',
        operation_applied: DrupalOperationMode.CREATE_NODE,
        http_status: 200,
        published_at: '2026-10-05T12:00:00+00:00',
      });
    });
  });

  describe('2. APPEND_HTML_BLOCK', () => {
    const appendParams = {
      operationMode: DrupalOperationMode.APPEND_HTML_BLOCK,
      bundle: 'node--page',
      targetNodeUuid: PAGE_UUID,
    };

    it('2.1 deberia leer el HTML actual antes de escribir', async () => {
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus
        .mockResolvedValueOnce(pageResponse(OTHER_BLOCK))
        .mockResolvedValueOnce(pageResponse(''));
      const strategy = buildStrategy(httpClient);

      await strategy.execute(buildContext(), appendParams);

      expect(callConfig(httpClient, 0).method).toBe('GET');
      expect(callConfig(httpClient, 0).url).toBe(
        `${BASE_URL}/node/page/${PAGE_UUID}`,
      );
    });

    it('2.2 deberia anteponer el bloque conservando el HTML previo', async () => {
      // 1. Arrange 📐: la pagina agregadora acumula licitaciones. Perder las
      //    anteriores al anadir una seria borrar el portal entero.
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus
        .mockResolvedValueOnce(pageResponse(OTHER_BLOCK))
        .mockResolvedValueOnce(pageResponse(''));
      const strategy = buildStrategy(httpClient);

      // 2. Act ⚙️
      await strategy.execute(buildContext(), appendParams);

      // 3. Assert 🎯
      const sent = (
        callBody(httpClient, 1).data?.attributes as Record<string, unknown>
      ).body as Record<string, string>;

      expect(sent.value.indexOf(MARKUP)).toBeLessThan(
        sent.value.indexOf(OTHER_BLOCK),
      );
      expect(sent.value).toContain(OTHER_BLOCK);
    });

    it('2.3 deberia respetar insertPosition APPEND', async () => {
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus
        .mockResolvedValueOnce(pageResponse(OTHER_BLOCK))
        .mockResolvedValueOnce(pageResponse(''));
      const strategy = buildStrategy(httpClient);

      await strategy.execute(buildContext(), {
        ...appendParams,
        insertPosition: 'APPEND',
      });

      const sent = (
        callBody(httpClient, 1).data?.attributes as Record<string, unknown>
      ).body as Record<string, string>;

      expect(sent.value.indexOf(MARKUP)).toBeGreaterThan(
        sent.value.indexOf(OTHER_BLOCK),
      );
    });

    it('2.4 deberia enviar data.id en el PATCH, como exige JSON:API', async () => {
      // 1. Arrange 📐: omitirlo devuelve un 422 cuyo cuerpo no dice que falta.
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus
        .mockResolvedValueOnce(pageResponse(''))
        .mockResolvedValueOnce(pageResponse(''));
      const strategy = buildStrategy(httpClient);

      // 2. Act ⚙️
      await strategy.execute(buildContext(), appendParams);

      // 3. Assert 🎯
      expect(callConfig(httpClient, 1).method).toBe('PATCH');
      expect(callBody(httpClient, 1).data).toMatchObject({
        type: 'node--page',
        id: PAGE_UUID,
      });
    });

    it('2.5 deberia tomar el nid del GET y no de la respuesta del PATCH', async () => {
      // 1. Arrange 📐: una instalacion de Drupal puede responder 204 a un
      //    PATCH, y entonces no habria atributos que leer. El GET ya es
      //    obligatorio en este modo, asi que el dato esta garantizado ahi.
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus
        .mockResolvedValueOnce(pageResponse('', PAGE_UUID, 55_937))
        .mockResolvedValueOnce({ data: {}, status: 204 });
      const strategy = buildStrategy(httpClient);

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), appendParams);

      // 3. Assert 🎯
      expect(result.data).toMatchObject({
        drupal_internal__nid: 55_937,
        path_alias: '/prueba-licitaciones',
        http_status: 204,
      });
    });

    it('2.6 deberia fallar con ERR_DRUPAL_DOM_TARGET si el contenedor no existe', async () => {
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus.mockResolvedValueOnce(
        pageResponse('<div class="otra-cosa"></div>'),
      );
      const strategy = buildStrategy(httpClient);

      const result = await strategy.execute(buildContext(), {
        ...appendParams,
        containerSelector: 'div.listado-licitaciones',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_DRUPAL_DOM_TARGET);
      expect(result.error?.level).toBe('GRAVE');
      // No se llego a escribir: solo hubo el GET.
      expect(httpClient.requestWithStatus).toHaveBeenCalledTimes(1);
    });
  });

  describe('3. TRANSFER_HTML_BLOCK: orden de escritura y atomicidad', () => {
    const transferParams = {
      operationMode: DrupalOperationMode.TRANSFER_HTML_BLOCK,
      bundle: 'node--page',
      targetNodeUuid: PAGE_UUID,
      destinationNodeUuid: CLOSED_UUID,
      itemSelector: EXPEDIENTE,
    };

    /** GET origen (con bloque), GET destino (vacio), PATCH destino, PATCH origen. */
    const mockHappyPath = (httpClient: HttpMock): void => {
      httpClient.requestWithStatus
        .mockResolvedValueOnce(pageResponse(BLOCK + OTHER_BLOCK, PAGE_UUID))
        .mockResolvedValueOnce(pageResponse('', CLOSED_UUID, 55_938))
        .mockResolvedValueOnce(pageResponse('', CLOSED_UUID, 55_938))
        .mockResolvedValueOnce(pageResponse('', PAGE_UUID));
    };

    it('3.1 deberia escribir PRIMERO en destino y DESPUES retirar de origen', async () => {
      // 1. Arrange 📐: es la decision central del modo. Al reves, el fallo de la
      //    segunda escritura PIERDE el bloque —ya no esta en origen y nunca
      //    llego a destino—, y como solo vivia dentro del `body.value` de la
      //    agregadora, la perdida es silenciosa e irreversible.
      const httpClient = buildHttpMock();
      mockHappyPath(httpClient);
      const strategy = buildStrategy(httpClient);

      // 2. Act ⚙️
      await strategy.execute(buildContext(), transferParams);

      // 3. Assert 🎯: las dos escrituras, en este orden.
      const patches = httpClient.requestWithStatus.mock.calls
        .map(([config]) => config)
        .filter((config) => config.method === 'PATCH');

      expect(patches).toHaveLength(2);
      expect(patches[0]?.url).toContain(CLOSED_UUID);
      expect(patches[1]?.url).toContain(PAGE_UUID);
    });

    it('3.2 deberia mover el bloque y dejar el resto de origen intacto', async () => {
      const httpClient = buildHttpMock();
      mockHappyPath(httpClient);
      const strategy = buildStrategy(httpClient);

      await strategy.execute(buildContext(), transferParams);

      const toDestination = (
        callBody(httpClient, 2).data?.attributes as Record<string, unknown>
      ).body as Record<string, string>;
      const toSource = (
        callBody(httpClient, 3).data?.attributes as Record<string, unknown>
      ).body as Record<string, string>;

      expect(toDestination.value).toContain('S_2026_015');
      expect(toSource.value).not.toContain('S_2026_015');
      expect(toSource.value).toContain('S_2026_001');
    });

    it('3.3 NO deberia escribir nada si el selector no casa en ninguna pagina', async () => {
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus
        .mockResolvedValueOnce(pageResponse(OTHER_BLOCK, PAGE_UUID))
        .mockResolvedValueOnce(pageResponse('', CLOSED_UUID));
      const strategy = buildStrategy(httpClient);

      const result = await strategy.execute(buildContext(), transferParams);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_DRUPAL_DOM_TARGET);
      expect(
        httpClient.requestWithStatus.mock.calls.every(
          ([config]) => config.method === 'GET',
        ),
      ).toBe(true);
    });

    it('3.4 deberia dejar el bloque INTACTO en origen si falla la escritura en destino', async () => {
      // 1. Arrange 📐: esta es la ventana segura. Nada se ha perdido y el nodo
      //    entero se puede reintentar.
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus
        .mockResolvedValueOnce(pageResponse(BLOCK, PAGE_UUID))
        .mockResolvedValueOnce(pageResponse('', CLOSED_UUID))
        .mockResolvedValueOnce(httpFailure(503));
      const strategy = buildStrategy(httpClient);

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), transferParams);

      // 3. Assert 🎯: nunca se llego a tocar la pagina de origen.
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_DRUPAL_SERVER);
      expect(
        httpClient.requestWithStatus.mock.calls.some(
          ([config]) =>
            config.method === 'PATCH' && config.url?.includes(PAGE_UUID),
        ),
      ).toBe(false);
    });

    it('3.5 deberia marcar el traslado como PARCIAL si falla la retirada de origen', async () => {
      // 1. Arrange 📐: la unica ventana de fallo real. Produce un DUPLICADO
      //    visible, no una perdida, y hay que poder distinguirlo sin leer texto.
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus
        .mockResolvedValueOnce(pageResponse(BLOCK, PAGE_UUID))
        .mockResolvedValueOnce(pageResponse('', CLOSED_UUID, 55_938))
        .mockResolvedValueOnce(pageResponse('', CLOSED_UUID, 55_938))
        .mockResolvedValueOnce(httpFailure(500));
      const strategy = buildStrategy(httpClient);

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), transferParams);

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({
        operation_applied: TRANSFER_PARTIAL_OPERATION,
        node_id: CLOSED_UUID,
      });
      expect(result.error?.message).toContain(CLOSED_UUID);
      expect(result.error?.message).toContain(PAGE_UUID);
      expect(result.error?.message).toContain('DUPLICADO');
    });

    it('3.6 deberia ser IDEMPOTENTE si el bloque ya esta en destino', async () => {
      // 1. Arrange 📐: es lo que hace seguro reintentar tras un traslado
      //    parcial. Sin esta guarda, el reintento duplicaria en destino.
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus
        .mockResolvedValueOnce(pageResponse(BLOCK, PAGE_UUID))
        .mockResolvedValueOnce(pageResponse(BLOCK, CLOSED_UUID, 55_938))
        .mockResolvedValueOnce(pageResponse('', PAGE_UUID));
      const strategy = buildStrategy(httpClient);

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), transferParams);

      // 3. Assert 🎯: una sola escritura, y va a ORIGEN (la limpieza pendiente).
      const patches = httpClient.requestWithStatus.mock.calls
        .map(([config]) => config)
        .filter((config) => config.method === 'PATCH');

      expect(result.success).toBe(true);
      expect(patches).toHaveLength(1);
      expect(patches[0]?.url).toContain(PAGE_UUID);
    });

    it('3.7 deberia cerrar en exito si el traslado ya se completo entero', async () => {
      // 1. Arrange 📐: ni en origen ni pendiente de limpiar. El trabajo ya
      //    estaba hecho y repetirlo no tiene sentido.
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus
        .mockResolvedValueOnce(pageResponse(OTHER_BLOCK, PAGE_UUID))
        .mockResolvedValueOnce(pageResponse(BLOCK, CLOSED_UUID, 55_938));
      const strategy = buildStrategy(httpClient);

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), transferParams);

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ node_id: CLOSED_UUID });
      expect(
        httpClient.requestWithStatus.mock.calls.every(
          ([config]) => config.method === 'GET',
        ),
      ).toBe(true);
    });
  });

  describe('4. UPLOAD_ATTACHMENT', () => {
    const uploadParams = {
      operationMode: DrupalOperationMode.UPLOAD_ATTACHMENT,
      bundle: 'node--page',
      targetNodeUuid: PAGE_UUID,
    };

    const withAttachment = (
      attachment: Record<string, unknown>,
    ): StatePayloadContext =>
      buildContext({ raw_email: { attachments: [attachment] } });

    const PDF = {
      filename: 'expediente.pdf',
      contentType: 'application/pdf',
      size: 10,
      contentBase64: 'JVBERi0xLjQK',
    };

    it('4.1 deberia hacer POST al endpoint de campo de fichero del anfitrion', async () => {
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus.mockResolvedValue(
        entityResponse({ uri: { url: '/sites/default/files/expediente.pdf' } }),
      );
      const strategy = buildStrategy(httpClient);

      await strategy.execute(withAttachment(PDF), uploadParams);

      expect(callConfig(httpClient, 0).url).toBe(
        `${BASE_URL}/node/page/${PAGE_UUID}/field_adjuntos`,
      );
      expect(callConfig(httpClient, 0).method).toBe('POST');
    });

    it('4.2 deberia enviar los bytes decodificados con cabeceras de binario', async () => {
      // 1. Arrange 📐: estas cabeceras SOBRESCRIBEN las de JSON:API; este
      //    endpoint no recibe un documento, recibe el fichero.
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus.mockResolvedValue(entityResponse());
      const strategy = buildStrategy(httpClient);

      // 2. Act ⚙️
      await strategy.execute(withAttachment(PDF), uploadParams);

      // 3. Assert 🎯
      expect(callConfig(httpClient, 0).headers).toMatchObject({
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'file; filename="expediente.pdf"',
      });
      expect(Buffer.isBuffer(callConfig(httpClient, 0).data)).toBe(true);
      expect(
        (callConfig(httpClient, 0).data as Buffer).toString('base64'),
      ).toBe(PDF.contentBase64);
    });

    it('4.3 deberia sanear el nombre para no inyectar cabeceras', async () => {
      // 1. Arrange 📐: `filename` lo controla quien ENVIA el correo, y aqui
      //    acaba dentro de una cabecera HTTP. Un `\r\n` la parte en dos.
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus.mockResolvedValue(entityResponse());
      const strategy = buildStrategy(httpClient);

      // 2. Act ⚙️
      await strategy.execute(
        withAttachment({
          ...PDF,
          filename: 'malo"\r\nX-Inyectado: si\r\n/../etc/passwd',
        }),
        uploadParams,
      );

      // 3. Assert 🎯
      const disposition = (
        callConfig(httpClient, 0).headers as Record<string, string>
      )['Content-Disposition'];

      expect(disposition).not.toContain('\r');
      expect(disposition).not.toContain('\n');
      expect(disposition).toBe(
        'file; filename="maloX-Inyectado: si..etcpasswd"',
      );
    });

    it('4.4 deberia seleccionar el adjunto por attachmentIndex', async () => {
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus.mockResolvedValue(entityResponse());
      const strategy = buildStrategy(httpClient);

      await strategy.execute(
        buildContext({
          raw_email: {
            attachments: [
              PDF,
              { ...PDF, filename: 'anexo.pdf', contentBase64: 'YW5leG8=' },
            ],
          },
        }),
        { ...uploadParams, attachmentIndex: 1 },
      );

      expect(
        (callConfig(httpClient, 0).headers as Record<string, string>)[
          'Content-Disposition'
        ],
      ).toContain('anexo.pdf');
    });

    it('4.5 deberia publicar la URL del fichero en path_alias', async () => {
      // 1. Arrange 📐: es el dato util del modo —el APPEND posterior lo inyecta
      //    en el `<a href>` del bloque— y el catalogo de salida es cerrado.
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus.mockResolvedValue(
        entityResponse(
          { uri: { url: '/sites/default/files/expediente.pdf' } },
          'uuid-fichero',
        ),
      );
      const strategy = buildStrategy(httpClient);

      // 2. Act ⚙️
      const result = await strategy.execute(withAttachment(PDF), uploadParams);

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        node_id: 'uuid-fichero',
        path_alias: '/sites/default/files/expediente.pdf',
        drupal_internal__nid: 0,
      });
    });

    it('4.6 deberia explicar la causa TOPOLOGICA si el motor libero el binario', async () => {
      // 1. Arrange 📐: el caso que de verdad se dara en produccion. El motor
      //    purga `contentBase64` en cuanto un nodo publica texto aprovechable,
      //    asi que un UPLOAD detras de un PARSER_PRE_IA ve el inventario entero
      //    y sin bytes. El mensaje tiene que mandar al operador a la topologia,
      //    no al adjunto.
      const httpClient = buildHttpMock();
      const strategy = buildStrategy(httpClient);

      // 2. Act ⚙️
      const result = await strategy.execute(
        withAttachment({ ...PDF, contentBase64: null }),
        uploadParams,
      );

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_DRUPAL_MISSING_PAYLOAD);
      expect(result.error?.message).toContain('liberado por el motor');
      expect(result.error?.message).toContain('PARSER_PRE_IA');
      expect(httpClient.requestWithStatus).not.toHaveBeenCalled();
    });

    it('4.7 deberia fallar si el indice pedido no existe', async () => {
      const httpClient = buildHttpMock();
      const strategy = buildStrategy(httpClient);

      const result = await strategy.execute(withAttachment(PDF), {
        ...uploadParams,
        attachmentIndex: 3,
      });

      expect(result.error?.code).toBe(ERR_DRUPAL_MISSING_PAYLOAD);
    });
  });

  describe('5. Traduccion de fallos HTTP', () => {
    const runWithFailure = async (
      status?: number,
    ): Promise<NodeErrorDetail | undefined> => {
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus.mockResolvedValue(httpFailure(status));
      const strategy = buildStrategy(httpClient);

      const result = await strategy.execute(buildContext(), {
        titleTemplate: 'Titular',
      });

      return result.error;
    };

    it('5.1 deberia traducir un 401 a ERR_DRUPAL_AUTH', async () => {
      expect((await runWithFailure(401))?.code).toBe(ERR_DRUPAL_AUTH);
    });

    it('5.2 deberia traducir un 403 a ERR_DRUPAL_AUTH', async () => {
      expect((await runWithFailure(403))?.code).toBe(ERR_DRUPAL_AUTH);
    });

    it('5.3 deberia traducir un 503 a ERR_DRUPAL_SERVER', async () => {
      expect((await runWithFailure(503))?.code).toBe(ERR_DRUPAL_SERVER);
    });

    it('5.4 deberia traducir un 422 a ERR_DRUPAL_REQUEST', async () => {
      expect((await runWithFailure(422))?.code).toBe(ERR_DRUPAL_REQUEST);
    });

    it('5.5 deberia traducir la AUSENCIA de estado a ERR_DRUPAL_NETWORK', async () => {
      // 1. Arrange 📐: sin estado no hubo respuesta que clasificar. Es DNS,
      //    conexion rechazada o timeout, y es justo eso lo que lo distingue de
      //    un rechazo del servidor remoto.
      expect((await runWithFailure(undefined))?.code).toBe(ERR_DRUPAL_NETWORK);
    });

    it('5.6 deberia emitir TODOS los fallos de red como GRAVE', async () => {
      // 1. Arrange 📐: es la decision de diseno del nodo, y conviene que un
      //    cambio la rompa en voz alta. GRAVE es el UNICO nivel que `canRetry`
      //    reintenta y el unico que deja la ejecucion PAUSADO conservando el
      //    cursor, que es lo que habilita el reintento manual de CU-09. Un LEVE
      //    cerraria en FALLIDO con `activeCursor: null` —sin nada que
      //    reanudar— y un URGENTE declararia irrecuperable un corte de red.
      const levels = await Promise.all(
        [401, 403, 422, 500, 503, undefined].map(
          async (status) => (await runWithFailure(status))?.level,
        ),
      );

      // 3. Assert 🎯
      expect(levels).toEqual([
        'GRAVE',
        'GRAVE',
        'GRAVE',
        'GRAVE',
        'GRAVE',
        'GRAVE',
      ]);
    });

    it('5.8 deberia conservar las SEIS claves de salida tambien al fallar', async () => {
      // 1. Arrange 📐: es la regresion que vigila esta prueba. El reparto de
      //    codigos vive ahora en `BaseHttpDestinationStrategy`, compartido con
      //    el futuro destino de Acens, pero el `data` NO: cada nodo tiene su
      //    propio inventario. Si alguien «simplificara» el helper para que
      //    devolviera el `NodeResult` entero —`{ success: false, error }`—,
      //    todas las rutas de error dejarian de publicar `http_status`, que es
      //    justo el campo que un `onErrorStep` necesita leer para decidir.
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus.mockResolvedValue(httpFailure(503));
      const strategy = buildStrategy(httpClient);

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        titleTemplate: 'Titular',
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(Object.keys(result.data ?? {}).sort()).toEqual([
        'drupal_internal__nid',
        'http_status',
        'node_id',
        'operation_applied',
        'path_alias',
        'published_at',
      ]);
      expect(result.data?.http_status).toBe(503);
    });

    it('5.7 deberia conservar el diagnostico que ya traia el cliente HTTP', async () => {
      // 1. Arrange 📐: `describeRemoteBody` ya recorto el cuerpo del remoto, que
      //    en Drupal es el `errors[].detail`. Perderlo obligaria a auditar a
      //    mano lo que el otro lado ya habia explicado.
      expect((await runWithFailure(422))?.message).toContain(
        'el remoto respondio 422',
      );
    });
  });

  describe('6. Fallos de configuracion y de contexto', () => {
    it('6.1 deberia rechazar una configuracion invalida', async () => {
      const strategy = buildStrategy(buildHttpMock());

      const result = await strategy.execute(buildContext(), {
        operationMode: 'MODO_INVENTADO',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_DRUPAL_CONFIG);
      expect(result.error?.level).toBe('GRAVE');
    });

    it('6.2 deberia rechazar un param desconocido', async () => {
      // 1. Arrange 📐: `forbidNonWhitelisted`, como en todo el proyecto. Un
      //    `targetUuid` mal escrito debe doler al guardar y no en ejecucion.
      const strategy = buildStrategy(buildHttpMock());

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        targetUuid: PAGE_UUID,
      });

      // 3. Assert 🎯
      expect(result.error?.code).toBe(ERR_DRUPAL_CONFIG);
    });

    it('6.3 deberia fallar sin DRUPAL_API_TOKEN antes de emitir ninguna peticion', async () => {
      const httpClient = buildHttpMock();
      const strategy = buildStrategy(httpClient, buildApiConfig(''));

      const result = await strategy.execute(buildContext(), {
        titleTemplate: 'Titular',
      });

      expect(result.error?.code).toBe(ERR_DRUPAL_CONFIG);
      expect(result.error?.message).toContain('DRUPAL_API_TOKEN');
      expect(httpClient.requestWithStatus).not.toHaveBeenCalled();
    });

    it('6.4 deberia fallar si el nodo de origen no llego a ejecutarse', async () => {
      const strategy = buildStrategy(buildHttpMock());

      const result = await strategy.execute(buildContext({}), {
        titleTemplate: 'Titular',
      });

      expect(result.error?.code).toBe(ERR_DRUPAL_MISSING_PAYLOAD);
      expect(result.error?.missingFields).toContain(SOURCE_NAMESPACE);
    });

    it('6.5 deberia fallar si el markup viene vacio en vez de publicar en blanco', async () => {
      // 1. Arrange 📐: es la guarda que separa «no publicar» de «publicar una
      //    noticia vacia en madrimasd.org con 200 OK y sin alerta».
      const strategy = buildStrategy(buildHttpMock());

      // 2. Act ⚙️
      const result = await strategy.execute(
        buildContext({ [SOURCE_NAMESPACE]: { [SOURCE_FIELD]: '   ' } }),
        { titleTemplate: 'Titular' },
      );

      // 3. Assert 🎯
      expect(result.error?.code).toBe(ERR_DRUPAL_MISSING_PAYLOAD);
    });

    it('6.6 deberia fallar si el titulo cita una variable que no existe', async () => {
      // 1. Arrange 📐: `getInterpolatedValue` LANZA a proposito ante una
      //    variable ausente, para no publicar un titular en blanco. Aqui se
      //    atrapa y se convierte al contrato del nodo en vez de propagarse,
      //    porque una excepcion la normaliza el motor a URGENTE.
      const strategy = buildStrategy(buildHttpMock());

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        titleTemplate: '{{llm_response.headline}}',
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_DRUPAL_MISSING_PAYLOAD);
      expect(result.error?.level).toBe('GRAVE');
    });
  });

  describe('7. Inventario de salida (outputFields)', () => {
    it('7.1 deberia declarar las seis claves del namespace', () => {
      const strategy = buildStrategy(buildHttpMock());

      expect(strategy.outputFields.map((field) => field.name)).toEqual([
        'node_id',
        'drupal_internal__nid',
        'path_alias',
        'operation_applied',
        'http_status',
        'published_at',
      ]);
    });

    /**
     * La paridad se comprueba en los CUATRO modos y no solo en uno.
     *
     * El inventario es lo que el selector del asistente ofrece como
     * `{{http_result.campo}}`. Si un modo emitiera cinco claves y otro seis, el
     * selector ofreceria variables que, segun con que modo corriera el destino,
     * no resolverian.
     */
    const expectParity = (
      strategy: DrupalHttpStrategy,
      data: Record<string, unknown> | undefined,
    ): void => {
      expect(Object.keys(data ?? {}).sort()).toEqual(
        strategy.outputFields.map((field) => field.name).sort(),
      );
    };

    it('7.2 deberia emitir las seis claves en CREATE_NODE', async () => {
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus.mockResolvedValue(entityResponse());
      const strategy = buildStrategy(httpClient);

      const result = await strategy.execute(buildContext(), {
        titleTemplate: 'Titular',
      });

      expectParity(strategy, result.data);
    });

    it('7.3 deberia emitir las seis claves en APPEND_HTML_BLOCK', async () => {
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus
        .mockResolvedValueOnce(pageResponse(''))
        .mockResolvedValueOnce(pageResponse(''));
      const strategy = buildStrategy(httpClient);

      const result = await strategy.execute(buildContext(), {
        operationMode: DrupalOperationMode.APPEND_HTML_BLOCK,
        bundle: 'node--page',
        targetNodeUuid: PAGE_UUID,
      });

      expectParity(strategy, result.data);
    });

    it('7.4 deberia emitir las seis claves en TRANSFER_HTML_BLOCK', async () => {
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus
        .mockResolvedValueOnce(pageResponse(BLOCK, PAGE_UUID))
        .mockResolvedValueOnce(pageResponse('', CLOSED_UUID))
        .mockResolvedValueOnce(pageResponse('', CLOSED_UUID))
        .mockResolvedValueOnce(pageResponse('', PAGE_UUID));
      const strategy = buildStrategy(httpClient);

      const result = await strategy.execute(buildContext(), {
        operationMode: DrupalOperationMode.TRANSFER_HTML_BLOCK,
        bundle: 'node--page',
        targetNodeUuid: PAGE_UUID,
        destinationNodeUuid: CLOSED_UUID,
        itemSelector: EXPEDIENTE,
      });

      expectParity(strategy, result.data);
    });

    it('7.5 deberia emitir las seis claves en UPLOAD_ATTACHMENT', async () => {
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus.mockResolvedValue(entityResponse());
      const strategy = buildStrategy(httpClient);

      const result = await strategy.execute(
        buildContext({
          raw_email: {
            attachments: [
              {
                filename: 'a.pdf',
                contentType: 'application/pdf',
                size: 4,
                contentBase64: 'YQ==',
              },
            ],
          },
        }),
        {
          operationMode: DrupalOperationMode.UPLOAD_ATTACHMENT,
          bundle: 'node--page',
          targetNodeUuid: PAGE_UUID,
        },
      );

      expectParity(strategy, result.data);
    });

    it('7.6 deberia emitir las seis claves TAMBIEN en el payload de un fallo', async () => {
      // 1. Arrange 📐: el motor publica el namespace cuando un fallo trae
      //    payload, asi que un payload mutilado llegaria igual a los nodos de
      //    aguas abajo.
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus.mockResolvedValue(httpFailure(500));
      const strategy = buildStrategy(httpClient);

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        titleTemplate: 'Titular',
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expectParity(strategy, result.data);
    });
  });

  describe('9. Autenticacion', () => {
    /**
     * La cuestion es de ENRUTADO, no de formato.
     *
     * Quien decide entre `Basic` y `Bearer` es `DrupalApiConfig.authHeader`, y
     * eso se prueba en su propio spec. Lo que se comprueba aqui es que los
     * CUATRO modos consumen ese getter en vez de componer la cabecera por su
     * cuenta: el 401 que motivo el cambio venia de que la estrategia cableaba
     * `Bearer`, y basta con que un modo se quede atras para reproducirlo.
     */
    const authHeaderOf = (httpClient: HttpMock, index: number): unknown =>
      (callConfig(httpClient, index).headers ?? {})[
        'Authorization' as keyof AxiosRequestConfig['headers']
      ];

    it('9.1 deberia autenticar el POST de CREATE_NODE', async () => {
      // 1. Arrange 📐
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus.mockResolvedValue(entityResponse());
      const strategy = buildStrategy(httpClient);

      // 2. Act ⚙️
      await strategy.execute(buildContext(), { titleTemplate: 'Titular' });

      // 3. Assert 🎯
      expect(authHeaderOf(httpClient, 0)).toBe(BASIC_AUTH_HEADER);
    });

    it('9.2 deberia autenticar el GET y el PATCH de APPEND_HTML_BLOCK', async () => {
      // 1. Arrange 📐: son DOS peticiones, y el PATCH es la que de verdad
      //    exigia credenciales: el GET de una pagina publica responde 200
      //    aunque vaya anonimo, que es lo que enmascaro el fallo original.
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus
        .mockResolvedValueOnce(pageResponse(OTHER_BLOCK))
        .mockResolvedValueOnce(pageResponse(OTHER_BLOCK));
      const strategy = buildStrategy(httpClient);

      // 2. Act ⚙️
      await strategy.execute(buildContext(), {
        operationMode: DrupalOperationMode.APPEND_HTML_BLOCK,
        bundle: 'node--page',
        targetNodeUuid: PAGE_UUID,
      });

      // 3. Assert 🎯
      expect(httpClient.requestWithStatus).toHaveBeenCalledTimes(2);
      expect(authHeaderOf(httpClient, 0)).toBe(BASIC_AUTH_HEADER);
      expect(authHeaderOf(httpClient, 1)).toBe(BASIC_AUTH_HEADER);
    });

    it('9.3 deberia autenticar las CUATRO peticiones de TRANSFER_HTML_BLOCK', async () => {
      // 1. Arrange 📐: dos lecturas y dos escrituras, en el orden invertido que
      //    documenta `runTransferHtmlBlock`.
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus
        .mockResolvedValueOnce(pageResponse(BLOCK))
        .mockResolvedValueOnce(pageResponse(OTHER_BLOCK))
        .mockResolvedValueOnce(pageResponse(OTHER_BLOCK))
        .mockResolvedValueOnce(pageResponse(''));
      const strategy = buildStrategy(httpClient);

      // 2. Act ⚙️
      await strategy.execute(buildContext(), {
        operationMode: DrupalOperationMode.TRANSFER_HTML_BLOCK,
        bundle: 'node--page',
        targetNodeUuid: PAGE_UUID,
        destinationNodeUuid: CLOSED_UUID,
        itemSelector: EXPEDIENTE,
      });

      // 3. Assert 🎯
      const headers = httpClient.requestWithStatus.mock.calls.map((_call, i) =>
        authHeaderOf(httpClient, i),
      );
      expect(headers).toHaveLength(4);
      expect(headers.every((header) => header === BASIC_AUTH_HEADER)).toBe(
        true,
      );
    });

    it('9.4 deberia autenticar el POST binario de UPLOAD_ATTACHMENT', async () => {
      // 1. Arrange 📐: este modo SOBRESCRIBE `Content-Type` y
      //    `Content-Disposition` sobre las de JSON:API. La cabecera de
      //    autenticacion tiene que sobrevivir a ese `spread`.
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus.mockResolvedValue(
        entityResponse({ uri: { url: '/sites/default/files/e.pdf' } }),
      );
      const strategy = buildStrategy(httpClient);

      // 2. Act ⚙️
      await strategy.execute(
        buildContext({
          raw_email: {
            attachments: [
              {
                filename: 'expediente.pdf',
                contentType: 'application/pdf',
                size: 10,
                contentBase64: 'JVBERi0xLjQK',
              },
            ],
          },
        }),
        {
          operationMode: DrupalOperationMode.UPLOAD_ATTACHMENT,
          bundle: 'node--page',
          targetNodeUuid: PAGE_UUID,
        },
      );

      // 3. Assert 🎯
      expect(authHeaderOf(httpClient, 0)).toBe(BASIC_AUTH_HEADER);
      expect(callConfig(httpClient, 0).headers).toMatchObject({
        'Content-Type': 'application/octet-stream',
      });
    });

    it('9.5 NO deberia emitir ninguna peticion si faltan credenciales', async () => {
      // 1. Arrange 📐: la guarda esta ANTES del `switch` justamente para no
      //    gastar una peticion que se sabe que va a volver 401.
      const httpClient = buildHttpMock();
      const strategy = buildStrategy(httpClient, buildApiConfig(''));

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        titleTemplate: 'Titular',
      });

      // 3. Assert 🎯
      expect(result.error?.code).toBe(ERR_DRUPAL_CONFIG);
      expect(httpClient.requestWithStatus).not.toHaveBeenCalled();
    });
  });

  describe('8. Inmutabilidad del contexto', () => {
    it('8.1 no deberia escribir en el contexto: eso es cosa del motor', async () => {
      // 1. Arrange 📐
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus.mockResolvedValue(entityResponse());
      const strategy = buildStrategy(httpClient);
      const context = buildContext();
      const spy = jest.spyOn(context, 'setNamespace');

      // 2. Act ⚙️
      await strategy.execute(context, { titleTemplate: 'Titular' });

      // 3. Assert 🎯
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
