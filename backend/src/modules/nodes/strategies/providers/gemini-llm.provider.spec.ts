import { GEMINI_API_KEY_VAR, GeminiLlmProvider } from './gemini-llm.provider';
import { MockLlmProvider } from './mock-llm.provider';

import type { HttpClientService } from '@core/http/http-client.service';
import type { ConfigService } from '@nestjs/config';
import type { LlmInlineAttachment } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import type { AxiosRequestConfig } from 'axios';

/**
 * Suite del CUERPO de la peticion, no de la API de Google.
 *
 * Lo que aqui se fija es la forma exacta del JSON saliente: es el contrato con
 * un servicio externo que no se puede ejercitar desde una prueba unitaria, y el
 * unico punto donde un cambio silencioso —una clave camelizada, un orden de
 * partes invertido— se detecta antes de producción.
 */

/** Doble del cliente HTTP, acotado al unico metodo que el proveedor invoca. */
type HttpMock = jest.Mocked<Pick<HttpClientService, 'request'>>;

const API_KEY = 'clave-de-prueba';

const SCAN: LlmInlineAttachment = {
  filename: 'nota.pdf',
  contentType: 'application/pdf',
  contentBase64: 'JVBERi0xLjQK',
};

/** Respuesta minima y valida de Gemini, con el contrato formal ya en JSON. */
const buildApiResponse = (): { data: unknown } => ({
  data: {
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                headline: 'Titular',
                summary: 'Resumen',
                body_paragraphs: ['Parrafo'],
              }),
            },
          ],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
  },
});

const buildHttp = (): HttpMock => ({
  request: jest.fn().mockResolvedValue(buildApiResponse()),
});

/**
 * `null` significa "la variable no esta en el entorno".
 *
 * No se usa `undefined` para eso: un parametro por defecto tambien se aplica
 * cuando se pasa `undefined` explicitamente, asi que `buildProvider(http,
 * undefined)` habria seguido inyectando la clave y la prueba de degradacion
 * habria pasado por el camino equivocado.
 */
const buildConfig = (apiKey: string | null = API_KEY): ConfigService =>
  ({
    get: jest.fn((variable: string) =>
      variable === GEMINI_API_KEY_VAR ? (apiKey ?? undefined) : undefined,
    ),
  }) as unknown as ConfigService;

const buildProvider = (
  http: HttpMock = buildHttp(),
  apiKey: string | null = API_KEY,
): GeminiLlmProvider =>
  new GeminiLlmProvider(
    http as unknown as HttpClientService,
    buildConfig(apiKey),
    new MockLlmProvider(),
  );

/** Partes del turno del usuario tal y como salieron en la peticion. */
const partsOf = (http: HttpMock): Record<string, unknown>[] => {
  const [config] = http.request.mock.calls[0] as [AxiosRequestConfig];
  const data = config.data as {
    contents: { parts: Record<string, unknown>[] }[];
  };

  return data.contents[0]?.parts ?? [];
};

describe('GeminiLlmProvider', () => {
  describe('1. Entrada multimodal', () => {
    it('1.1 deberia anadir una parte inline_data por adjunto', async () => {
      // 1. Arrange 📐
      const http = buildHttp();
      const provider = buildProvider(http);

      // 2. Act ⚙️
      await provider.generateCompletion(
        'Extrae la nota.',
        undefined,
        undefined,
        [SCAN],
      );

      // 3. Assert 🎯: `inline_data` y `mime_type` van en snake_case porque asi
      //    los nombra la API REST de Google. El SDK los expone camelizados, pero
      //    aqui se habla REST directamente y camelizarlos seria un 400.
      expect(partsOf(http)).toEqual([
        { text: 'Extrae la nota.' },
        {
          inline_data: {
            mime_type: 'application/pdf',
            data: 'JVBERi0xLjQK',
          },
        },
      ]);
    });

    it('1.2 deberia poner el texto SIEMPRE por delante de los adjuntos', async () => {
      // 1. Arrange 📐: el orden de las partes es significativo. Con la imagen
      //    delante, el modelo tiende a describirla en vez de extraer lo que se
      //    le pide sobre ella.
      const http = buildHttp();
      const provider = buildProvider(http);

      // 2. Act ⚙️
      await provider.generateCompletion('', undefined, undefined, [SCAN, SCAN]);

      // 3. Assert 🎯
      const parts = partsOf(http);
      expect(parts[0]).toEqual({ text: '' });
      expect(parts).toHaveLength(3);
    });

    it('1.3 NO deberia alterar el cuerpo cuando no hay adjuntos', async () => {
      // 1. Arrange 📐: el modo de siempre no cambia ni un byte.
      const http = buildHttp();
      const provider = buildProvider(http);

      // 2. Act ⚙️
      await provider.generateCompletion('Redacta una noticia.');

      // 3. Assert 🎯
      expect(partsOf(http)).toEqual([{ text: 'Redacta una noticia.' }]);
    });
  });

  describe('2. Degradacion sin credencial', () => {
    it('2.1 deberia trasladar los adjuntos al simulador', async () => {
      // 1. Arrange 📐: sin `GEMINI_API_KEY` no se construye peticion alguna,
      //    pero el simulador debe recibir lo mismo que habria recibido el
      //    proveedor real: de lo contrario, un desarrollador sin clave no puede
      //    comprobar que el modo vision recolecta lo que cree.
      const http = buildHttp();
      const provider = buildProvider(http, null);
      jest
        .spyOn(provider['logger'], 'warn')
        .mockImplementation(() => undefined);

      // 2. Act ⚙️
      const result = await provider.generateCompletion(
        '',
        undefined,
        undefined,
        [SCAN],
      );

      // 3. Assert 🎯
      expect(http.request).not.toHaveBeenCalled();
      expect(result.metadata.isMock).toBe(true);
      expect(result.summary).toContain('nota.pdf');
    });
  });
});
