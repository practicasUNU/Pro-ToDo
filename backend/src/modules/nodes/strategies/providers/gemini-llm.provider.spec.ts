import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_API_KEY_VAR,
  GeminiLlmProvider,
} from './gemini-llm.provider';
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

/** `generationConfig` tal y como salio en la peticion. */
const generationConfigOf = (http: HttpMock): Record<string, unknown> => {
  const [config] = http.request.mock.calls[0] as [AxiosRequestConfig];
  const data = config.data as { generationConfig: Record<string, unknown> };

  return data.generationConfig;
};

/** Partes del turno del usuario tal y como salieron en la peticion. */
const partsOf = (http: HttpMock): Record<string, unknown>[] => {
  const [config] = http.request.mock.calls[0] as [AxiosRequestConfig];
  const data = config.data as {
    contents: { parts: Record<string, unknown>[] }[];
  };

  return data.contents[0]?.parts ?? [];
};

/** Peticion saliente completa, tal y como se paso al cliente HTTP. */
const requestOf = (http: HttpMock): AxiosRequestConfig => {
  const [config] = http.request.mock.calls[0] as [AxiosRequestConfig];

  return config;
};

describe('GeminiLlmProvider', () => {
  describe('0. Direccion de la peticion', () => {
    it('0.1 deberia llamar a v1beta con el separador ":" antes de generateContent', async () => {
      // 1. Arrange 📐: el modelo viaja en el PATH, no en el cuerpo, asi que un
      //    error aqui no da un 400 de validacion sino un 404 de ruta. Hasta
      //    PROT-23 ninguna prueba miraba la URL, y por ese hueco paso un 404
      //    real que costo una auditoria entera distinguir de una URL rota.
      const http = buildHttp();
      const provider = buildProvider(http);

      // 2. Act ⚙️
      await provider.generateCompletion('Extrae la nota.');

      // 3. Assert 🎯: dos puntos y NO barra; si fuera `/generateContent`,
      //    Google lo interpretaria como otro recurso y devolveria 404.
      expect(requestOf(http).url).toBe(
        `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`,
      );
    });

    it('0.2 deberia usar el modelo que declara el nodo por encima del defecto', async () => {
      // 1. Arrange 📐
      const http = buildHttp();
      const provider = buildProvider(http);

      // 2. Act ⚙️
      await provider.generateCompletion('Extrae la nota.', undefined, {
        model: 'gemini-3.8-flash',
      });

      // 3. Assert 🎯
      expect(requestOf(http).url).toContain(
        '/models/gemini-3.8-flash:generateContent',
      );
    });

    it('0.3 deberia llevar la clave en cabecera y nunca en el query string', async () => {
      // 1. Arrange 📐: un `?key=` acaba en los logs de acceso de cualquier
      //    proxy que haya por el camino.
      const http = buildHttp();
      const provider = buildProvider(http);

      // 2. Act ⚙️
      await provider.generateCompletion('Extrae la nota.');

      // 3. Assert 🎯
      const request = requestOf(http);

      expect(request.headers?.['x-goog-api-key']).toBe(API_KEY);
      expect(request.url).not.toContain('key=');
      expect(request.url).not.toContain(API_KEY);
    });
  });

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

  describe('3. Presupuesto de la llamada', () => {
    it('3.1 deberia enviar temperatura y tope de tokens cuando el nodo los declara', async () => {
      // 1. Arrange 📐: el nodo de OCR fija 0.1 para transcribir con fidelidad.
      //    Hasta PROT-22 ese valor no salia de la configuracion.
      const http = buildHttp();
      const provider = buildProvider(http);

      // 2. Act ⚙️
      await provider.generateCompletion('Transcribe.', undefined, {
        model: 'gemini-3.6-flash',
        timeoutMs: 30_000,
        maxRetries: 2,
        temperature: 0.1,
        maxTokens: 4_096,
      });

      // 3. Assert 🎯
      expect(generationConfigOf(http)).toEqual({
        responseMimeType: 'application/json',
        temperature: 0.1,
        maxOutputTokens: 4_096,
      });
    });

    it('3.2 deberia OMITIRLOS cuando el nodo no los declara', async () => {
      // 1. Arrange 📐: el defecto de cada modelo lo publica Google y cambia con
      //    el modelo. Fijar aqui un valor propio congelaria una decision que no
      //    es de este repositorio.
      const http = buildHttp();
      const provider = buildProvider(http);

      // 2. Act ⚙️
      await provider.generateCompletion('Redacta.');

      // 3. Assert 🎯
      expect(generationConfigOf(http)).toEqual({
        responseMimeType: 'application/json',
      });
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
