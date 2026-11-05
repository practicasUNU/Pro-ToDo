import { NodeType } from '@core/fsm/types/pipeline-schema.types';

import { createMockStatePayloadContext } from '@test/factories/state-payload-context.factory';
import { AcensHttpConfigDto } from '../dto/acens-http-config.dto';

import {
  AcensHttpStrategy,
  ERR_DESTINO_ACENS_CONFIG,
  ERR_DESTINO_ACENS_FAILED,
  ERR_DESTINO_ACENS_MISSING_CONTEXT,
  ERR_DESTINO_ACENS_NETWORK,
} from './acens-http.strategy';

import type { AcensApiConfig } from '@core/config/acens-api.config';
import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type { HttpClientService } from '@core/http/http-client.service';
import type { AxiosRequestConfig } from 'axios';

/**
 * Suite del CONTRATO del destino Acens. Cliente HTTP y entorno van MOCKEADOS:
 * ninguna prueba sale a la red.
 */

const BASE_URL = 'https://api.acens.com/v1';

type HttpMock = jest.Mocked<Pick<HttpClientService, 'requestWithResponse'>>;

const OK_RESPONSE = {
  data: { id: 'camp-7', queued: true },
  status: 202,
  statusText: 'Accepted',
  headers: {},
};

const buildHarness = (
  env: Partial<Pick<AcensApiConfig, 'baseUrl' | 'isUsable'>> = {},
): { strategy: AcensHttpStrategy; http: HttpMock } => {
  const http: HttpMock = {
    requestWithResponse: jest.fn().mockResolvedValue(OK_RESPONSE),
  };
  const acensConfig = {
    baseUrl: BASE_URL,
    isUsable: true,
    timeoutMs: 15_000,
    authHeader: 'Bearer clave-acens',
    ...env,
  } as AcensApiConfig;

  return {
    strategy: new AcensHttpStrategy(
      http as unknown as HttpClientService,
      acensConfig,
    ),
    http,
  };
};

const buildContext = (): StatePayloadContext =>
  createMockStatePayloadContext({
    currentStep: 'destino_acens',
    namespaces: {
      llm_response: {
        headline: 'Convocatoria "Ayudas" 2026',
        summary: 'Resumen <script>alert(1)</script>limpio',
        slug: 'lista/../admin',
      },
    },
  });

const sentConfig = (http: HttpMock): AxiosRequestConfig =>
  http.requestWithResponse.mock.calls[0]?.[0];

describe('AcensHttpStrategy (DESTINO_ACENS)', () => {
  describe('0. Identidad y contratos declarativos', () => {
    it('0.1 deberia declarar tipo, DTO y la firma del namespace', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const { strategy } = buildHarness();

      // 3. Assert 🎯
      expect(strategy.nodeType).toBe(NodeType.DESTINO_ACENS);
      expect(strategy.paramsSchema).toBe(AcensHttpConfigDto);
      expect(strategy.outputFields.map((field) => field.name)).toEqual([
        'statusCode',
        'responseBody',
        'dispatchedAt',
        'campaign_id',
        'status',
        'dispatched_at',
        'recipient_list',
        'raw_response',
      ]);
    });

    it('0.2 deberia exigir endpointPath para ejecutar y deducir namespaces', () => {
      // 1. Arrange 📐
      const { strategy } = buildHarness();

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(strategy.getIncompleteParams({})).toEqual(['endpointPath']);
      expect(
        strategy.getRequiredNamespaces({
          endpointPath: '/campaigns/{{llm_response.slug}}',
          payloadTemplate: '{"t": "{{parsed_email.clean_title}}"}',
        }),
      ).toEqual(expect.arrayContaining(['llm_response', 'parsed_email']));
      expect(
        strategy.getUnreachableErrorCodes({ endpointPath: '/campaigns' }),
      ).toEqual([ERR_DESTINO_ACENS_MISSING_CONTEXT]);
    });
  });

  describe('1. Composicion de la peticion', () => {
    it('1.1 deberia unir la raiz del entorno con la ruta y firmar con la clave', async () => {
      // 1. Arrange 📐
      const { strategy, http } = buildHarness();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        method: 'POST',
        endpointPath: '/campaigns',
        headers: { 'X-Origen': 'proto-do' },
        payloadTemplate:
          '{"subject": "{{llm_response.headline}}", "body": "{{llm_response.summary}}"}',
      });

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        statusCode: 202,
        responseBody: { id: 'camp-7', queued: true },
      });
      expect(sentConfig(http)).toMatchObject({
        url: `${BASE_URL}/campaigns`,
        method: 'POST',
        headers: {
          'X-Origen': 'proto-do',
          Authorization: 'Bearer clave-acens',
          'Content-Type': 'application/json',
        },
        data: {
          subject: 'Convocatoria "Ayudas" 2026',
          body: 'Resumen limpio',
        },
        maxRedirects: 0,
      });
      expect(http.requestWithResponse.mock.calls[0]?.[1]).toMatchObject({
        maxRetries: 0,
      });
    });

    it('1.2 deberia codificar el valor interpolado en la ruta sin escapar de la raiz', async () => {
      // 1. Arrange 📐
      const { strategy, http } = buildHarness();

      // 2. Act ⚙️
      await strategy.execute(buildContext(), {
        method: 'GET',
        endpointPath: '/lists/{{llm_response.slug}}',
      });

      // 3. Assert 🎯
      expect(sentConfig(http).url).toBe(`${BASE_URL}/lists/lista%2F..%2Fadmin`);
      expect(sentConfig(http).data).toBeUndefined();
    });
  });

  describe('2. Fallos controlados', () => {
    it.each([404, 422, 503])(
      '2.1 deberia devolver ERR_DESTINO_ACENS_FAILED (GRAVE) ante un %i',
      async (status) => {
        // 1. Arrange 📐
        const { strategy, http } = buildHarness();
        http.requestWithResponse.mockResolvedValue({
          failure: {
            level: 'GRAVE',
            code: 'ERR_HTTP',
            message: `HTTP ${status}`,
          },
          status,
        });

        // 2. Act ⚙️
        const result = await strategy.execute(buildContext(), {
          endpointPath: '/campaigns',
        });

        // 3. Assert 🎯
        expect(result.success).toBe(false);
        expect(result.error?.level).toBe('GRAVE');
        expect(result.error?.code).toBe(ERR_DESTINO_ACENS_FAILED);
        expect(result.data).toMatchObject({ statusCode: status });
      },
    );

    it('2.2 deberia devolver _NETWORK cuando no hubo respuesta', async () => {
      // 1. Arrange 📐
      const { strategy, http } = buildHarness();
      http.requestWithResponse.mockResolvedValue({
        failure: { level: 'GRAVE', code: 'ERR_HTTP', message: 'ETIMEDOUT' },
      });

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        endpointPath: '/campaigns',
      });

      // 3. Assert 🎯
      expect(result.error?.code).toBe(ERR_DESTINO_ACENS_NETWORK);
    });

    it('2.3 deberia parar con _CONFIG sin despachar si el entorno no declara Acens', async () => {
      // 1. Arrange 📐
      const { strategy, http } = buildHarness({ isUsable: false });

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        endpointPath: '/campaigns',
      });

      // 3. Assert 🎯
      expect(result.error?.code).toBe(ERR_DESTINO_ACENS_CONFIG);
      expect(http.requestWithResponse).not.toHaveBeenCalled();
    });

    it.each([
      'https://evil.example/x',
      '//evil.example/x',
      '/a/../../x',
      'campaigns',
    ])(
      '2.4 deberia rechazar la ruta no relativa "%s"',
      async (endpointPath) => {
        // 1. Arrange 📐
        const { strategy, http } = buildHarness();

        // 2. Act ⚙️
        const result = await strategy.execute(buildContext(), { endpointPath });

        // 3. Assert 🎯
        expect(result.error?.code).toBe(ERR_DESTINO_ACENS_CONFIG);
        expect(http.requestWithResponse).not.toHaveBeenCalled();
      },
    );

    it('2.5 deberia devolver _MISSING_CONTEXT si una variable no resuelve', async () => {
      // 1. Arrange 📐
      const { strategy, http } = buildHarness();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        endpointPath: '/campaigns',
        payloadTemplate: '{"t": "{{parsed_email.clean_title}}"}',
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_DESTINO_ACENS_MISSING_CONTEXT);
      expect(result.error?.missingFields).toEqual(['parsed_email.clean_title']);
      expect(http.requestWithResponse).not.toHaveBeenCalled();
    });

    it('2.6 deberia rechazar un cuerpo en un GET y la cabecera Authorization', async () => {
      // 1. Arrange 📐
      const { strategy } = buildHarness();

      // 2. Act ⚙️
      const withBody = await strategy.execute(buildContext(), {
        method: 'GET',
        endpointPath: '/campaigns',
        payloadTemplate: '{"a": "b"}',
      });
      const withAuth = await strategy.execute(buildContext(), {
        endpointPath: '/campaigns',
        headers: { Authorization: 'Bearer otra' },
      });

      // 3. Assert 🎯
      expect(withBody.error?.code).toBe(ERR_DESTINO_ACENS_CONFIG);
      expect(withAuth.error?.code).toBe(ERR_DESTINO_ACENS_CONFIG);
    });
  });

  describe('3. CREATE_CAMPAIGN (boletin de Notiweb)', () => {
    const API_KEY = 'clave-acens-secreta';
    const CAMPAIGN_BASE = 'https://acens.mail-servicios.com';

    const campaignHarness = (
      response: unknown = {
        data: { campaign_id: 'c-91' },
        status: 200,
        statusText: 'OK',
        headers: {},
      },
    ): { strategy: AcensHttpStrategy; http: HttpMock } => {
      const http: HttpMock = {
        requestWithResponse: jest.fn().mockResolvedValue(response),
      };
      const acensConfig = {
        baseUrl: CAMPAIGN_BASE,
        apiKey: API_KEY,
        isUsable: true,
        timeoutMs: 15_000,
        authHeader: `Bearer ${API_KEY}`,
      } as AcensApiConfig;

      return {
        strategy: new AcensHttpStrategy(
          http as unknown as HttpClientService,
          acensConfig,
        ),
        http,
      };
    };

    /** Escudo con la raiz y dos noticias mas en `validated_items`. */
    const batchContext = (sandbox = false): StatePayloadContext =>
      createMockStatePayloadContext({
        currentStep: 'campana_acens',
        namespaces: {
          validated_drupal_json: {
            validated_markup: '<h2>Noticia 1</h2>',
            validated_items: [
              {
                validated_markup: '<h2>Noticia 2</h2>',
                validated_fields: {},
                character_count: 17,
              },
              {
                validated_markup: '<h2>Noticia 3</h2>',
                validated_fields: {},
                character_count: 17,
              },
            ],
          },
        },
        ...(sandbox ? { sandboxScope: { userId: 'admin-1' } } : {}),
      });

    const campaignParams = {
      operation: 'CREATE_CAMPAIGN',
      listId: 'lista-42',
    };

    it('3.1 deberia crear la campana en /api/1/createCampaign/ con el token en el cuerpo y todas las noticias', async () => {
      // 1. Arrange 📐
      const { strategy, http } = campaignHarness();

      // 2. Act ⚙️
      const result = await strategy.execute(batchContext(), campaignParams);

      // 3. Assert 🎯
      const config = sentConfig(http);
      const body = config.data as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(config.url).toBe(`${CAMPAIGN_BASE}/api/1/createCampaign/`);
      expect(config.method).toBe('POST');
      expect(config.headers).toMatchObject({
        Accept: 'application/json',
        'Content-Type': 'application/json',
      });
      expect(config.headers).not.toHaveProperty('Authorization');
      expect(body.auth_token).toBe(API_KEY);
      expect(body.lists).toEqual({ '0': 'lista-42' });
      expect(body.from_name).toBe('Notiweb');
      expect(body.from_email).toBe('notiweb@madrimasd.org');
      expect(String(body.name)).toMatch(/^Notiweb \d{2}\/\d{2}\/\d{4}$/);
      expect(String(body.subject)).toMatch(
        /^Servicio NotiWEB de madri\+d \d{2}\/\d{2}\/\d{4}$/,
      );
      expect(body.content).toBe(
        '<h2>Noticia 1</h2>\n<h2>Noticia 2</h2>\n<h2>Noticia 3</h2>',
      );
      expect(http.requestWithResponse.mock.calls[0]?.[1]).toMatchObject({
        maxRetries: 0,
      });
      expect(result.data).toMatchObject({
        campaign_id: 'c-91',
        status: 'CAMPAIGN_CREATED',
        recipient_list: 'lista-42',
      });
    });

    it('3.2 no deberia dejar el token en el contexto aunque el remoto lo refleje', async () => {
      // 1. Arrange 📐
      const { strategy } = campaignHarness({
        data: { id: 'c-1', echo: { auth_token: API_KEY } },
        status: 202,
        statusText: 'Accepted',
        headers: {},
      });

      // 2. Act ⚙️
      const result = await strategy.execute(batchContext(), campaignParams);

      // 3. Assert 🎯
      expect(result.data?.status).toBe('QUEUED');
      expect(JSON.stringify(result.data)).not.toContain(API_KEY);
    });

    it('3.3 en el banco de pruebas deberia devolver TEST_MODE sin llamar a Acens', async () => {
      // 1. Arrange 📐
      const { strategy, http } = campaignHarness();

      // 2. Act ⚙️
      const result = await strategy.execute(batchContext(true), campaignParams);

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(http.requestWithResponse).not.toHaveBeenCalled();
      expect(result.data).toMatchObject({
        status: 'TEST_MODE',
        campaign_id: '',
        recipient_list: 'lista-42',
      });
      expect(JSON.stringify(result.data)).not.toContain(API_KEY);
    });

    it('3.4 deberia exigir la lista para ejecutar', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      const { strategy } = campaignHarness();

      expect(
        strategy.getIncompleteParams({ operation: 'CREATE_CAMPAIGN' }),
      ).toEqual(['listId']);
      expect(strategy.getRequiredNamespaces(campaignParams)).toEqual([
        'validated_drupal_json',
      ]);
    });

    it('3.5 deberia fallar sin marcado validado que enviar', async () => {
      // 1. Arrange 📐
      const { strategy, http } = campaignHarness();
      const context = createMockStatePayloadContext({
        currentStep: 'campana_acens',
        namespaces: { validated_drupal_json: { validated_markup: '' } },
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, campaignParams);

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_DESTINO_ACENS_MISSING_CONTEXT);
      expect(http.requestWithResponse).not.toHaveBeenCalled();
    });

    it('3.6 deberia traducir un 4xx a ERR_DESTINO_ACENS_FAILED sin filtrar el token', async () => {
      // 1. Arrange 📐
      const http: HttpMock = {
        requestWithResponse: jest.fn().mockResolvedValue({
          failure: {
            level: 'GRAVE',
            code: 'ERR_HTTP_CLIENT_REJECTED',
            message: `token ${API_KEY} no valido`,
          },
          status: 401,
        }),
      };
      const strategy = new AcensHttpStrategy(
        http as unknown as HttpClientService,
        {
          baseUrl: CAMPAIGN_BASE,
          apiKey: API_KEY,
          isUsable: true,
          timeoutMs: 15_000,
          authHeader: '',
        } as AcensApiConfig,
      );

      // 2. Act ⚙️
      const result = await strategy.execute(batchContext(), campaignParams);

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_DESTINO_ACENS_FAILED);
      expect(result.error?.message).not.toContain(API_KEY);
    });

    it('3.7 deberia rechazar un correo de remitente invalido', async () => {
      // 1. Arrange 📐
      const { strategy, http } = campaignHarness();

      // 2. Act ⚙️
      const result = await strategy.execute(batchContext(), {
        ...campaignParams,
        fromEmail: 'no-es-un-correo',
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_DESTINO_ACENS_CONFIG);
      expect(http.requestWithResponse).not.toHaveBeenCalled();
    });
  });
});
