import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { BlockedOutboundTargetError } from '@core/http/outbound-url.guard';
import {
  ApiKeyPlacement,
  CredentialAuthType,
} from '@modules/credentials/enums/credential-auth-type.enum';
import { createMockStatePayloadContext } from '@test/factories/state-payload-context.factory';

import { HttpGenericDestinationConfigDto } from '../dto/http-generic-destination-config.dto';

import {
  ERR_HTTP_GENERIC_AUTH,
  ERR_HTTP_GENERIC_CONFIG,
  ERR_HTTP_GENERIC_CREDENTIAL,
  ERR_HTTP_GENERIC_MISSING_CONTEXT,
  ERR_HTTP_GENERIC_NETWORK,
  ERR_HTTP_GENERIC_REQUEST,
  ERR_HTTP_GENERIC_SERVER,
  ERR_HTTP_GENERIC_TARGET_BLOCKED,
  HttpGenericDestinationStrategy,
  MAX_RESPONSE_BODY_CHARS,
} from './http-generic-destination.strategy';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type { HttpClientService } from '@core/http/http-client.service';
import type {
  CredentialsService,
  SecretResolution,
} from '@modules/credentials/credentials.service';
import type { AxiosRequestConfig } from 'axios';

/**
 * Suite del CONTRATO del conector: lo que sale por el cable y lo que se
 * publica en el namespace. Cliente HTTP, boveda y guarda SSRF van MOCKEADOS:
 * ninguna prueba sale a la red ni descifra nada real.
 */

const TARGET_URL = 'https://api.ejemplo.org/v1/avisos';
const CREDENTIAL_ID = '0b9a2c47-5d1e-4f3a-8c6b-2e7d9f1a4b30';

type HttpMock = jest.Mocked<Pick<HttpClientService, 'requestWithResponse'>>;
type VaultMock = jest.Mocked<Pick<CredentialsService, 'resolveSecret'>>;
type GuardMock = { assertPublicTarget: jest.Mock; lookup: jest.Mock };

const OK_RESPONSE = {
  data: { id: 42, ok: true },
  status: 201,
  statusText: 'Created',
  headers: {
    'content-type': 'application/json',
    'set-cookie': 'sesion=secreta',
  },
};

const buildHarness = (
  secret: SecretResolution = { reason: 'NOT_FOUND' },
): {
  strategy: HttpGenericDestinationStrategy;
  http: HttpMock;
  vault: VaultMock;
  guard: GuardMock;
} => {
  const http: HttpMock = {
    requestWithResponse: jest.fn().mockResolvedValue(OK_RESPONSE),
  };
  const vault: VaultMock = {
    resolveSecret: jest.fn().mockResolvedValue(secret),
  };
  const guard: GuardMock = {
    assertPublicTarget: jest.fn((url: string) => Promise.resolve(new URL(url))),
    lookup: jest.fn(),
  };

  return {
    strategy: new HttpGenericDestinationStrategy(
      http as unknown as HttpClientService,
      vault as unknown as CredentialsService,
      guard,
    ),
    http,
    vault,
    guard,
  };
};

const buildContext = (): StatePayloadContext =>
  createMockStatePayloadContext({
    currentStep: 'destino_http_generico',
    namespaces: {
      parsed_email: {
        clean_title: 'Convocatoria "Ayudas" 2026',
        clean_body: 'Linea 1\nLinea 2',
        sender: 'ana@ejemplo.org',
      },
    },
  });

/** Configuracion Axios con la que se llamo al cliente. */
const sentConfig = (http: HttpMock): AxiosRequestConfig =>
  http.requestWithResponse.mock.calls[0]?.[0];

describe('HttpGenericDestinationStrategy (DESTINO_HTTP_GENERICO)', () => {
  describe('0. Identidad y contratos declarativos', () => {
    it('0.1 deberia declarar tipo, DTO y la firma inmutable del namespace', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const { strategy } = buildHarness();

      // 3. Assert 🎯
      expect(strategy.nodeType).toBe(NodeType.DESTINO_HTTP_GENERICO);
      expect(strategy.paramsSchema).toBe(HttpGenericDestinationConfigDto);
      expect(strategy.outputFields.map((field) => field.name)).toEqual([
        'statusCode',
        'statusText',
        'responseBody',
        'headers',
        'dispatchedAt',
      ]);
    });

    it('0.2 deberia deducir los namespaces de URL, cabeceras, query y cuerpo', () => {
      // 1. Arrange 📐
      const { strategy } = buildHarness();

      // 2. Act ⚙️
      const required = strategy.getRequiredNamespaces({
        targetUrl: 'https://api.ejemplo.org/{{scraped_web.slug}}',
        headers: { 'X-Origen': '{{raw_email.from}}' },
        queryParams: { q: '{{ocr_result.clean_body}}' },
        bodyTemplate: '{"titulo": "{{parsed_email.clean_title}}"}',
      });

      // 3. Assert 🎯
      expect([...required].sort()).toEqual(
        ['ocr_result', 'parsed_email', 'raw_email', 'scraped_web'].sort(),
      );
    });

    it('0.3 deberia exigir URL y credencial para ACTIVAR, no para guardar', () => {
      // 1. Arrange 📐
      const { strategy } = buildHarness();

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(strategy.getIncompleteParams({})).toEqual(['targetUrl']);
      expect(
        strategy.getIncompleteParams({
          targetUrl: TARGET_URL,
          authType: 'BEARER_TOKEN',
        }),
      ).toEqual(['authConfig.credentialId']);
    });

    it('0.4 deberia declarar inalcanzable el fallo de credencial sin autenticacion', () => {
      // 1. Arrange 📐
      const { strategy } = buildHarness();

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(strategy.getUnreachableErrorCodes({ authType: 'NONE' })).toEqual([
        ERR_HTTP_GENERIC_CREDENTIAL,
      ]);
      expect(
        strategy.getUnreachableErrorCodes({ authType: 'API_KEY' }),
      ).toEqual([]);
    });
  });

  describe('1. Composicion de la peticion', () => {
    it('1.1 deberia interpolar el JSON hoja a hoja sin romperlo con comillas', async () => {
      // 1. Arrange 📐: el titular trae comillas y el cuerpo un salto de linea;
      //    sustituidos en crudo dejarian un JSON invalido.
      const { strategy, http } = buildHarness();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
        bodyTemplate:
          '{"titulo": "{{parsed_email.clean_title}}", "meta": {"lineas": ["{{parsed_email.clean_body}}"]}}',
      });

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(sentConfig(http)).toMatchObject({
        url: TARGET_URL,
        method: 'POST',
        data: {
          titulo: 'Convocatoria "Ayudas" 2026',
          meta: { lineas: ['Linea 1\nLinea 2'] },
        },
        headers: { 'Content-Type': 'application/json' },
        maxRedirects: 0,
      });
    });

    it('1.2 deberia enviar FORM_DATA como x-www-form-urlencoded', async () => {
      // 1. Arrange 📐
      const { strategy, http } = buildHarness();

      // 2. Act ⚙️
      await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
        bodyType: 'FORM_DATA',
        bodyTemplate:
          '{"remitente": "{{parsed_email.sender}}", "tipo": "aviso & alta"}',
      });

      // 3. Assert 🎯
      expect(sentConfig(http).data).toBe(
        'remitente=ana%40ejemplo.org&tipo=aviso+%26+alta',
      );
      expect(sentConfig(http).headers).toMatchObject({
        'Content-Type': 'application/x-www-form-urlencoded',
      });
    });

    it('1.3 deberia enviar RAW_TEXT y respetar un Content-Type del operador', async () => {
      // 1. Arrange 📐
      const { strategy, http } = buildHarness();

      // 2. Act ⚙️
      await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
        method: 'PUT',
        bodyType: 'RAW_TEXT',
        bodyTemplate: 'Aviso: {{parsed_email.clean_title}}',
        headers: { 'content-type': 'text/markdown' },
      });

      // 3. Assert 🎯
      expect(sentConfig(http)).toMatchObject({
        method: 'PUT',
        data: 'Aviso: Convocatoria "Ayudas" 2026',
        headers: { 'content-type': 'text/markdown' },
      });
      expect(sentConfig(http).headers).not.toHaveProperty('Content-Type');
    });

    it('1.4 deberia enviar un GET sin cuerpo y la query en params, no en la URL', async () => {
      // 1. Arrange 📐: la URL se registra en los avisos del cliente HTTP; la
      //    query viaja aparte para que una API key nunca acabe en el log.
      const { strategy, http } = buildHarness();

      // 2. Act ⚙️
      await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
        method: 'GET',
        bodyType: 'NONE',
        queryParams: { remitente: '{{parsed_email.sender}}' },
      });

      // 3. Assert 🎯
      expect(sentConfig(http).url).toBe(TARGET_URL);
      expect(sentConfig(http).params).toEqual({ remitente: 'ana@ejemplo.org' });
      expect(sentConfig(http)).not.toHaveProperty('data');
    });

    it('1.5 deberia fallar GRAVE si un marcador no resuelve, sin despachar', async () => {
      // 1. Arrange 📐
      const { strategy, http } = buildHarness();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        targetUrl: 'https://api.ejemplo.org/{{scraped_web.slug}}',
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_HTTP_GENERIC_MISSING_CONTEXT);
      expect(http.requestWithResponse).not.toHaveBeenCalled();
    });

    it('1.5b deberia despachar a una URL tomada entera de un paso anterior', async () => {
      // 1. Arrange 📐: la direccion sale del contexto, indice incluido.
      const { strategy, http, guard } = buildHarness();
      const context = buildContext();
      context.setNamespace('parsed_email', {
        extracted_urls: [
          'https://api.ejemplo.org/a',
          'https://api.ejemplo.org/b',
        ],
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {
        targetUrl: '{{parsed_email.extracted_urls[1]}}',
      });

      // 3. Assert 🎯: la guarda SSRF juzga la URL YA interpolada.
      expect(result.success).toBe(true);
      expect(guard.assertPublicTarget).toHaveBeenCalledWith(
        'https://api.ejemplo.org/b',
      );
      expect(sentConfig(http).url).toBe('https://api.ejemplo.org/b');
    });

    it('1.6 deberia rechazar params invalidos como configuracion GRAVE', async () => {
      // 1. Arrange 📐: un GET con cuerpo y una cabecera Authorization a mano.
      const { strategy, http } = buildHarness();

      // 2. Act ⚙️
      const withBody = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
        method: 'GET',
        bodyType: 'JSON',
      });
      const manualAuth = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
        headers: { Authorization: 'Bearer en-claro' },
      });

      // 3. Assert 🎯
      expect(withBody.error?.code).toBe(ERR_HTTP_GENERIC_CONFIG);
      expect(manualAuth.error?.code).toBe(ERR_HTTP_GENERIC_CONFIG);
      expect(manualAuth.error?.message).toContain('credencial');
      expect(http.requestWithResponse).not.toHaveBeenCalled();
    });
  });

  describe('2. Proteccion SSRF', () => {
    it('2.1 deberia bloquear un destino privado antes de despachar', async () => {
      // 1. Arrange 📐
      const { strategy, http, guard } = buildHarness();
      guard.assertPublicTarget.mockRejectedValue(
        new BlockedOutboundTargetError('"intranet.local" resuelve a 10.0.0.5'),
      );

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        targetUrl: 'https://intranet.local/api',
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({
        level: 'GRAVE',
        code: ERR_HTTP_GENERIC_TARGET_BLOCKED,
      });
      expect(http.requestWithResponse).not.toHaveBeenCalled();
    });

    it('2.2 deberia conectar con el lookup de la guarda (anti DNS rebinding)', async () => {
      // 1. Arrange 📐
      const { strategy, http, guard } = buildHarness();

      // 2. Act ⚙️
      await strategy.execute(buildContext(), { targetUrl: TARGET_URL });

      // 3. Assert 🎯
      expect(sentConfig(http).lookup).toBe(guard.lookup);
    });
  });

  describe('3. Autenticacion por credencial de la boveda', () => {
    it.each([
      [
        'BEARER_TOKEN',
        { authType: CredentialAuthType.BEARER_TOKEN, token: 'tok_123' },
        { Authorization: 'Bearer tok_123' },
      ],
      [
        'BASIC_AUTH',
        {
          authType: CredentialAuthType.BASIC_AUTH,
          username: 'svc',
          password: 'p:ss',
        },
        // `svc:p:ss` en base64, fijado como literal a proposito.
        { Authorization: 'Basic c3ZjOnA6c3M=' },
      ],
      [
        'API_KEY',
        {
          authType: CredentialAuthType.API_KEY,
          keyName: 'X-Api-Key',
          apiKey: 'k-1',
          placement: ApiKeyPlacement.HEADER,
        },
        { 'X-Api-Key': 'k-1' },
      ],
    ] as const)(
      '3.1 deberia aplicar la credencial %s sin publicarla en el namespace',
      async (authType, secret, expectedHeaders) => {
        // 1. Arrange 📐
        const { strategy, http, vault } = buildHarness({
          secret,
        });

        // 2. Act ⚙️
        const result = await strategy.execute(buildContext(), {
          targetUrl: TARGET_URL,
          authType,
          authConfig: { credentialId: CREDENTIAL_ID },
        });

        // 3. Assert 🎯
        expect(vault.resolveSecret).toHaveBeenCalledWith(CREDENTIAL_ID);
        expect(sentConfig(http).headers).toMatchObject(expectedHeaders);
        const published = JSON.stringify(result.data);
        for (const value of Object.values(expectedHeaders)) {
          expect(published).not.toContain(value);
        }
      },
    );

    it('3.2 deberia mandar una API key de QUERY en params', async () => {
      // 1. Arrange 📐
      const { strategy, http } = buildHarness({
        secret: {
          authType: CredentialAuthType.API_KEY,
          keyName: 'api_key',
          apiKey: 'k-2',
          placement: ApiKeyPlacement.QUERY,
        },
      });

      // 2. Act ⚙️
      await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
        authType: 'API_KEY',
        authConfig: { credentialId: CREDENTIAL_ID },
      });

      // 3. Assert 🎯
      expect(sentConfig(http).url).toBe(TARGET_URL);
      expect(sentConfig(http).params).toEqual({ api_key: 'k-2' });
    });

    it('3.3 deberia fallar GRAVE si la credencial no existe o es de otro tipo', async () => {
      // 1. Arrange 📐
      const missing = buildHarness({ reason: 'NOT_FOUND' });
      const mismatched = buildHarness({
        secret: { authType: CredentialAuthType.BEARER_TOKEN, token: 't' },
      });
      const params = {
        targetUrl: TARGET_URL,
        authType: 'BASIC_AUTH',
        authConfig: { credentialId: CREDENTIAL_ID },
      };

      // 2. Act ⚙️
      const notFound = await missing.strategy.execute(buildContext(), params);
      const wrongType = await mismatched.strategy.execute(
        buildContext(),
        params,
      );

      // 3. Assert 🎯
      expect(notFound.error).toMatchObject({
        level: 'GRAVE',
        code: ERR_HTTP_GENERIC_CREDENTIAL,
      });
      expect(wrongType.error).toMatchObject({
        level: 'GRAVE',
        code: ERR_HTTP_GENERIC_CREDENTIAL,
      });
      expect(missing.http.requestWithResponse).not.toHaveBeenCalled();
      expect(mismatched.http.requestWithResponse).not.toHaveBeenCalled();
    });
  });

  describe('4. Traduccion de fallos HTTP', () => {
    it.each([
      [401, ERR_HTTP_GENERIC_AUTH],
      [404, ERR_HTTP_GENERIC_REQUEST],
      [429, ERR_HTTP_GENERIC_REQUEST],
      [503, ERR_HTTP_GENERIC_SERVER],
      [undefined, ERR_HTTP_GENERIC_NETWORK],
    ])('4.1 deberia traducir %s a %s, siempre GRAVE', async (status, code) => {
      // 1. Arrange 📐
      const { strategy, http } = buildHarness();
      http.requestWithResponse.mockResolvedValue({
        failure: {
          level: 'GRAVE',
          code: 'ERR_HTTP_CLIENT_REJECTED',
          message: 'rechazo',
        },
        ...(status === undefined ? {} : { status }),
      });

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({ level: 'GRAVE', code });
      expect(result.data).toMatchObject({ statusCode: status ?? 0 });
    });

    it('4.2 deberia marcar exhausted cuando ya gasto sus propios reintentos', async () => {
      // 1. Arrange 📐: sin la marca, `canRetry` sumaria los del retryPolicy.
      const { strategy, http } = buildHarness();
      http.requestWithResponse.mockResolvedValue({
        failure: {
          level: 'GRAVE',
          code: 'ERR_HTTP_TIMEOUT',
          message: 'timeout',
        },
      });

      // 2. Act ⚙️
      const withRetries = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
        retryAttempts: 2,
        timeoutMs: 5_000,
      });
      const withoutRetries = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
      });

      // 3. Assert 🎯
      expect(withRetries.error?.metadata).toMatchObject({
        exhausted: true,
        maxRetries: 2,
      });
      expect(withoutRetries.error?.metadata?.exhausted).toBeUndefined();
      expect(http.requestWithResponse.mock.calls[0]?.[1]).toEqual({
        timeoutMs: 5_000,
        maxRetries: 2,
      });
    });
  });

  describe('5. Namespace publicado', () => {
    it('5.1 deberia publicar la firma completa y sin set-cookie', async () => {
      // 1. Arrange 📐
      const { strategy } = buildHarness();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
      });

      // 3. Assert 🎯
      const { dispatchedAt, ...rest } = result.data ?? {};
      expect(rest).toEqual({
        statusCode: 201,
        statusText: 'Created',
        responseBody: { id: 42, ok: true },
        headers: { 'content-type': 'application/json' },
      });
      expect(String(dispatchedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('5.2 deberia recortar un cuerpo de respuesta desmesurado', async () => {
      // 1. Arrange 📐
      const { strategy, http } = buildHarness();
      http.requestWithResponse.mockResolvedValue({
        ...OK_RESPONSE,
        data: 'x'.repeat(MAX_RESPONSE_BODY_CHARS + 10),
      });

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        targetUrl: TARGET_URL,
      });

      // 3. Assert 🎯
      expect(String(result.data?.responseBody)).toContain('[recortado:');
    });

    it('5.3 no deberia mutar el contexto que recibe', async () => {
      // 1. Arrange 📐
      const { strategy } = buildHarness();
      const context = buildContext();
      const before = JSON.stringify(context.getAllContext());

      // 2. Act ⚙️
      await strategy.execute(context, {
        targetUrl: TARGET_URL,
        bodyTemplate: '{"t": "{{parsed_email.clean_title}}"}',
      });

      // 3. Assert 🎯
      expect(JSON.stringify(context.getAllContext())).toBe(before);
    });
  });
});
