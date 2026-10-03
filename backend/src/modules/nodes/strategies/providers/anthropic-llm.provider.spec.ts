import {
  ANTHROPIC_API_KEY_VAR,
  ANTHROPIC_API_URL,
  ANTHROPIC_VERSION,
  AnthropicLlmProvider,
  AnthropicProviderException,
  DEFAULT_ANTHROPIC_MODEL,
} from './anthropic-llm.provider';
import { MockLlmProvider } from './mock-llm.provider';

import type { HttpClientService } from '@core/http/http-client.service';
import type { ConfigService } from '@nestjs/config';
import type { LlmInlineAttachment } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import type { AxiosRequestConfig } from 'axios';

/**
 * Suite del CUERPO de la peticion, no de la API de Anthropic.
 *
 * Mismo criterio que la de Gemini: lo que aqui se fija es la forma exacta del
 * JSON saliente. Es el contrato con un servicio externo que una prueba unitaria
 * no puede ejercitar, y el unico punto donde un cambio silencioso —una cabecera
 * perdida, un PDF enviado como imagen— se detecta antes de produccion.
 */

/** Doble del cliente HTTP, acotado al unico metodo que el proveedor invoca. */
type HttpMock = jest.Mocked<Pick<HttpClientService, 'request'>>;

const API_KEY = 'sk-ant-clave-de-prueba';

const PROMPT = 'Redacta la noticia a partir del material.';
const SYSTEM_PROMPT = 'Eres el redactor jefe de Madrid+D.';

const SCAN: LlmInlineAttachment = {
  filename: 'nota.pdf',
  contentType: 'application/pdf',
  contentBase64: 'JVBERi0xLjQK',
};

const PHOTO: LlmInlineAttachment = {
  filename: 'cartel.png',
  contentType: 'image/png',
  contentBase64: 'iVBORw0KGgo=',
};

/** Respuesta minima y valida, con el contrato formal ya en JSON. */
const buildApiResponse = (): { data: unknown } => ({
  data: {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          headline: 'Titular',
          summary: 'Resumen',
          body_paragraphs: ['Parrafo'],
        }),
      },
    ],
    usage: { input_tokens: 10, output_tokens: 20 },
    stop_reason: 'end_turn',
  },
});

const buildHttp = (): HttpMock => ({
  request: jest.fn().mockResolvedValue(buildApiResponse()),
});

/**
 * `null` significa "la variable no esta en el entorno".
 *
 * No se usa `undefined`: un parametro por defecto tambien se aplica cuando se
 * pasa `undefined` explicitamente, asi que la prueba de degradacion habria
 * pasado por el camino equivocado.
 */
const buildConfig = (apiKey: string | null = API_KEY): ConfigService =>
  ({
    get: jest.fn((variable: string) =>
      variable === ANTHROPIC_API_KEY_VAR ? (apiKey ?? undefined) : undefined,
    ),
  }) as unknown as ConfigService;

const buildProvider = (
  http: HttpMock = buildHttp(),
  apiKey: string | null = API_KEY,
): AnthropicLlmProvider =>
  new AnthropicLlmProvider(
    http as unknown as HttpClientService,
    buildConfig(apiKey),
    new MockLlmProvider(),
  );

/** Configuracion saliente tal y como se la entrego el proveedor al cliente. */
const sentConfig = (http: HttpMock): AxiosRequestConfig =>
  http.request.mock.calls[0]?.[0];

/** Cuerpo de la peticion, ya tipado como objeto. */
const sentBody = (http: HttpMock): Record<string, unknown> =>
  sentConfig(http).data as Record<string, unknown>;

/** Bloques del turno del usuario tal y como salieron en la peticion. */
const sentContent = (http: HttpMock): Record<string, unknown>[] => {
  const messages = sentBody(http).messages as {
    content: Record<string, unknown>[];
  }[];

  return messages[0]?.content ?? [];
};

describe('AnthropicLlmProvider · cliente de Claude sobre la Messages API', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('0.1 deberia declararse como el proveedor ANTHROPIC', () => {
    // 1. Arrange 📐 & 2. Act ⚙️
    const provider = buildProvider();

    // 3. Assert 🎯
    expect(provider.provider).toBe('ANTHROPIC');
  });

  describe('1. Peticion saliente', () => {
    it('1.1 deberia enviar la clave en cabecera y nunca en la URL', async () => {
      // 1. Arrange 📐: un query string acaba en los logs de acceso de
      //    cualquier proxy del camino.
      const http = buildHttp();

      // 2. Act ⚙️
      await buildProvider(http).generateCompletion(PROMPT);

      // 3. Assert 🎯
      const config = sentConfig(http);
      expect(config.url).toBe(ANTHROPIC_API_URL);
      expect(config.url).not.toContain(API_KEY);
      expect(config.headers).toMatchObject({
        'x-api-key': API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
      });
    });

    it('1.2 deberia usar el modelo por defecto cuando el nodo no declara uno', async () => {
      // 1. Arrange 📐
      const http = buildHttp();

      // 2. Act ⚙️
      await buildProvider(http).generateCompletion(PROMPT);

      // 3. Assert 🎯
      expect(sentBody(http).model).toBe(DEFAULT_ANTHROPIC_MODEL);
    });

    it('1.3 deberia respetar el modelo, el timeout y los reintentos del nodo', async () => {
      // 1. Arrange 📐: los dos ultimos no van en el cuerpo, sino en las
      //    opciones del cliente compartido, que es quien aplica la politica.
      const http = buildHttp();

      // 2. Act ⚙️
      await buildProvider(http).generateCompletion(PROMPT, undefined, {
        model: 'claude-opus-5-5',
        timeoutMs: 9_000,
        maxRetries: 1,
      });

      // 3. Assert 🎯
      expect(sentBody(http).model).toBe('claude-opus-5-5');
      expect(http.request.mock.calls[0]?.[1]).toEqual({
        timeoutMs: 9_000,
        maxRetries: 1,
      });
    });

    it('1.4 deberia poner el contrato de formato DESPUES de la instruccion del operador', async () => {
      // 1. Arrange 📐: el contrato va el ultimo para que sea lo mas reciente
      //    que el modelo lee antes de responder.
      const http = buildHttp();

      // 2. Act ⚙️
      await buildProvider(http).generateCompletion(PROMPT, SYSTEM_PROMPT);

      // 3. Assert 🎯
      const system = sentBody(http).system as string;
      expect(system.startsWith(SYSTEM_PROMPT)).toBe(true);
      expect(system).toContain('"body_paragraphs"');
      expect(system.indexOf(SYSTEM_PROMPT)).toBeLessThan(
        system.indexOf('"body_paragraphs"'),
      );
    });

    it('1.5 deberia enviar solo el contrato cuando no hay instruccion del operador', async () => {
      // 1. Arrange 📐: el campo `system` nunca puede quedar vacio; el nodo
      //    depende del contrato de salida aunque el prompt no diga nada del rol.
      const http = buildHttp();

      // 2. Act ⚙️
      await buildProvider(http).generateCompletion(PROMPT, '   ');

      // 3. Assert 🎯
      const system = sentBody(http).system as string;
      expect(system).toContain('"headline"');
      expect(system.trim().startsWith('Responde')).toBe(true);
    });

    it('1.6 deberia exigir el JSON por esquema en vez de rescatarlo con regex', async () => {
      // 1. Arrange 📐: parsear texto libre seria el parser de formato ad hoc
      //    que `security-and-scope.md` §3 prohibe construir.
      const http = buildHttp();

      // 2. Act ⚙️
      await buildProvider(http).generateCompletion(PROMPT);

      // 3. Assert 🎯
      expect(sentBody(http).output_config).toMatchObject({
        format: { type: 'json_schema' },
      });
    });
  });

  describe('2. Entrada multimodal', () => {
    it('2.1 deberia dejar un solo bloque de texto cuando no hay adjuntos', async () => {
      // 1. Arrange 📐: el modo de siempre no debe cambiar.
      const http = buildHttp();

      // 2. Act ⚙️
      await buildProvider(http).generateCompletion(PROMPT);

      // 3. Assert 🎯
      expect(sentContent(http)).toEqual([{ type: 'text', text: PROMPT }]);
    });

    it('2.2 deberia poner el texto PRIMERO y los adjuntos despues', async () => {
      // 1. Arrange 📐: la instruccion de que hacer con la imagen debe leerse
      //    antes que la imagen, o el modelo la describe en vez de extraer.
      const http = buildHttp();

      // 2. Act ⚙️
      await buildProvider(http).generateCompletion(
        PROMPT,
        undefined,
        undefined,
        [PHOTO],
      );

      // 3. Assert 🎯
      const content = sentContent(http);
      expect(content[0]).toEqual({ type: 'text', text: PROMPT });
      expect(content[1]).toMatchObject({ type: 'image' });
    });

    it('2.3 deberia enviar un PDF como `document` y una imagen como `image`', async () => {
      // 1. Arrange 📐: en esta API un PDF NO es una imagen. Mandarlo como tal
      //    devuelve un 400, asi que se discrimina por MIME.
      const http = buildHttp();

      // 2. Act ⚙️
      await buildProvider(http).generateCompletion(
        PROMPT,
        undefined,
        undefined,
        [SCAN, PHOTO],
      );

      // 3. Assert 🎯
      const content = sentContent(http);
      expect(content[1]).toEqual({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: SCAN.contentBase64,
        },
      });
      expect(content[2]).toEqual({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: PHOTO.contentBase64,
        },
      });
    });
  });

  describe('3. Respuesta', () => {
    it('3.1 deberia mapear el contrato formal y los contadores de tokens', async () => {
      // 1. Arrange 📐
      const http = buildHttp();

      // 2. Act ⚙️
      const payload = await buildProvider(http).generateCompletion(PROMPT);

      // 3. Assert 🎯
      expect(payload).toEqual({
        headline: 'Titular',
        summary: 'Resumen',
        body_paragraphs: ['Parrafo'],
        metadata: {
          tokensPrompt: 10,
          tokensCompletion: 20,
          modelUsed: DEFAULT_ANTHROPIC_MODEL,
          isMock: false,
        },
      });
    });

    it('3.2 deberia tomar el primer bloque de TEXTO, no el primer bloque', async () => {
      // 1. Arrange 📐: la respuesta puede abrir con bloques de otro tipo, y un
      //    indice fijo leeria el que no es.
      const http = buildHttp();
      http.request.mockResolvedValue({
        data: {
          content: [
            { type: 'thinking', thinking: '' },
            {
              type: 'text',
              text: JSON.stringify({
                headline: 'H',
                summary: 'S',
                body_paragraphs: [],
              }),
            },
          ],
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      });

      // 2. Act ⚙️
      const payload = await buildProvider(http).generateCompletion(PROMPT);

      // 3. Assert 🎯
      expect(payload.headline).toBe('H');
    });

    it('3.3 deberia descartar lo que no sea una cadena en body_paragraphs', async () => {
      // 1. Arrange 📐: el esquema lo pide, pero el modelo no esta obligado a
      //    cumplirlo al pie de la letra y el nodo no puede propagar basura.
      const http = buildHttp();
      http.request.mockResolvedValue({
        data: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                headline: 'H',
                summary: 'S',
                body_paragraphs: ['  valido  ', 42, null, '   '],
              }),
            },
          ],
        },
      });

      // 2. Act ⚙️
      const payload = await buildProvider(http).generateCompletion(PROMPT);

      // 3. Assert 🎯
      expect(payload.body_paragraphs).toEqual(['valido']);
      // Sin bloque `usage` los contadores caen a cero, nunca a `undefined`.
      expect(payload.metadata.tokensPrompt).toBe(0);
    });
  });

  describe('4. Fallos', () => {
    it('4.1 deberia LANZAR cuando el cliente HTTP devuelve un fallo', async () => {
      // 1. Arrange 📐: lanzar es lo que exige `ILlmProviderClient`. La
      //    excepcion es la senal que alimenta el freno de emergencia de la
      //    estrategia.
      const http = buildHttp();
      http.request.mockResolvedValue({
        failure: {
          level: 'GRAVE',
          code: 'ERR_NODE_HTTP_TIMEOUT',
          message: 'se agoto la espera',
        },
      });

      // 2. Act ⚙️ & 3. Assert 🎯
      await expect(
        buildProvider(http).generateCompletion(PROMPT),
      ).rejects.toThrow(AnthropicProviderException);
    });

    it('4.2 deberia LANZAR ante una respuesta sin contenido generado', async () => {
      // 1. Arrange 📐
      const http = buildHttp();
      http.request.mockResolvedValue({
        data: { content: [], stop_reason: 'max_tokens' },
      });

      // 2. Act ⚙️ & 3. Assert 🎯: el `stop_reason` viaja en el mensaje porque
      //    es lo unico que explica por que no hay texto.
      await expect(
        buildProvider(http).generateCompletion(PROMPT),
      ).rejects.toThrow(/max_tokens/);
    });

    it('4.3 deberia LANZAR cuando el cuerpo no es JSON valido', async () => {
      // 1. Arrange 📐
      const http = buildHttp();
      http.request.mockResolvedValue({
        data: { content: [{ type: 'text', text: 'Claro, aqui tienes:' }] },
      });

      // 2. Act ⚙️ & 3. Assert 🎯
      await expect(
        buildProvider(http).generateCompletion(PROMPT),
      ).rejects.toThrow(AnthropicProviderException);
    });
  });

  describe('5. Degradacion a simulacion', () => {
    it('5.1 deberia delegar en el simulador sin ANTHROPIC_API_KEY, sin salir a la red', async () => {
      // 1. Arrange 📐: la ausencia de la clave es un estado NORMAL del entorno
      //    de desarrollo. Fallar obligaria a repartir credenciales de pago para
      //    probar la topologia de un pipeline.
      const http = buildHttp();

      // 2. Act ⚙️
      const payload = await buildProvider(http, null).generateCompletion(
        PROMPT,
      );

      // 3. Assert 🎯: la degradacion queda marcada en el namespace y es
      //    auditable; nadie puede confundirla con una redaccion real.
      expect(http.request).not.toHaveBeenCalled();
      expect(payload.metadata.isMock).toBe(true);
    });

    it('5.2 deberia degradar tambien con la clave vacia o en blanco', async () => {
      // 1. Arrange 📐: un `.env` con `ANTHROPIC_API_KEY=` es tan comun como no
      //    declararla, y mandar una cadena vacia solo gastaria un 401.
      const http = buildHttp();

      // 2. Act ⚙️
      const payload = await buildProvider(http, '   ').generateCompletion(
        PROMPT,
      );

      // 3. Assert 🎯
      expect(http.request).not.toHaveBeenCalled();
      expect(payload.metadata.isMock).toBe(true);
    });
  });
});
