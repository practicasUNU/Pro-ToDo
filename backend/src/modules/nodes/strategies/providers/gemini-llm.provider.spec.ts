import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_API_KEY_VAR,
  GeminiLlmProvider,
} from './gemini-llm.provider';
import {
  ERR_LLM_PROVIDER_CONTRACT,
  ERR_LLM_PROVIDER_TRUNCATED,
} from '@modules/nodes/strategies/interfaces/llm-provider.interface';
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
        maxTokens: 8_192,
      });

      // 3. Assert 🎯
      expect(generationConfigOf(http)).toEqual({
        responseMimeType: 'application/json',
        temperature: 0.1,
        maxOutputTokens: 8_192,
      });
    });

    it('3.3 deberia anidar el nivel de pensamiento donde la API lo espera', async () => {
      // 1. Arrange 📐: el nombre de campo importa y esta comprobado contra el
      //    endpoint real. Ni `thinkingLevel` suelto ni `thinking_level` existen
      //    en `generationConfig`: los dos devuelven un 400 "Cannot find field"
      //    que parece un error de payload del nodo.
      const http = buildHttp();
      const provider = buildProvider(http);

      // 2. Act ⚙️
      await provider.generateCompletion('Transcribe.', undefined, {
        model: 'gemini-3.6-flash',
        timeoutMs: 30_000,
        maxRetries: 2,
        thinkingLevel: 'minimal',
      });

      // 3. Assert 🎯
      expect(generationConfigOf(http)).toEqual({
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingLevel: 'minimal' },
      });
    });

    it('3.4 deberia rebajar a low el modelo que no admite minimal', async () => {
      // 1. Arrange 📐: `minimal` solo lo admiten las familias 3.5 y 3.6. En una
      //    3.8 seria un 400; rebajar conserva la intencion del nodo —pensar lo
      //    menos posible— en vez de convertirla en un fallo.
      const http = buildHttp();
      const provider = buildProvider(http);

      // 2. Act ⚙️
      await provider.generateCompletion('Transcribe.', undefined, {
        model: 'gemini-3.8-flash',
        timeoutMs: 30_000,
        maxRetries: 2,
        thinkingLevel: 'minimal',
      });

      // 3. Assert 🎯
      expect(generationConfigOf(http)).toMatchObject({
        thinkingConfig: { thinkingLevel: 'low' },
      });
    });

    it('3.5 deberia respetar un nivel superior tal cual', async () => {
      // 1. Arrange 📐: la rebaja solo aplica a `minimal`; el resto de la escala
      //    la admite toda la gama.
      const http = buildHttp();
      const provider = buildProvider(http);

      // 2. Act ⚙️
      await provider.generateCompletion('Redacta.', undefined, {
        model: 'gemini-3.8-flash',
        timeoutMs: 15_000,
        maxRetries: 3,
        thinkingLevel: 'high',
      });

      // 3. Assert 🎯
      expect(generationConfigOf(http)).toMatchObject({
        thinkingConfig: { thinkingLevel: 'high' },
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

  describe('4. Decodificacion de la respuesta', () => {
    /** Contrato valido, para envolverlo de distintas formas. */
    const CONTRACT = JSON.stringify({
      headline: 'Titular',
      summary: 'Resumen',
      body_paragraphs: ['Parrafo'],
    });

    /** Respuesta con las partes y el motivo de corte que se quieran. */
    const buildResponse = (
      parts: readonly Record<string, unknown>[],
      finishReason = 'STOP',
      usageMetadata: Record<string, unknown> = {},
    ): { data: unknown } => ({
      data: {
        candidates: [{ content: { parts }, finishReason }],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 20,
          ...usageMetadata,
        },
      },
    });

    /** Cliente HTTP que devuelve una respuesta concreta. */
    const httpReturning = (response: { data: unknown }): HttpMock => ({
      request: jest.fn().mockResolvedValue(response),
    });

    it('4.1 deberia parsear un contrato envuelto en vallas Markdown', async () => {
      // 1. Arrange 📐: se le pide JSON puro, pero a veces lo entrega dentro de
      //    ```json ... ```. Eso reventaba el parseo con un error que acusaba al
      //    contrato en vez de a la envoltura.
      const http = httpReturning(
        buildResponse([{ text: '```json\n' + CONTRACT + '\n```' }]),
      );
      const provider = buildProvider(http);

      // 2. Act ⚙️
      const result = await provider.generateCompletion('Transcribe.');

      // 3. Assert 🎯
      expect(result.headline).toBe('Titular');
      expect(result.body_paragraphs).toEqual(['Parrafo']);
    });

    it('4.2 deberia concatenar TODAS las partes antes de parsear', async () => {
      // 1. Arrange 📐: una salida larga se trocea, y quedarse con `parts[0]`
      //    entregaba al parser un JSON cortado por la mitad.
      const half = Math.floor(CONTRACT.length / 2);
      const http = httpReturning(
        buildResponse([
          { text: CONTRACT.slice(0, half) },
          { text: CONTRACT.slice(half) },
        ]),
      );
      const provider = buildProvider(http);

      // 2. Act ⚙️
      const result = await provider.generateCompletion('Transcribe.');

      // 3. Assert 🎯
      expect(result.summary).toBe('Resumen');
    });

    it('4.3 deberia descartar las partes de deliberacion', async () => {
      // 1. Arrange 📐: el razonamiento del modelo no es contenido, y colarlo en
      //    la cadena a parsear la invalida entera.
      const http = httpReturning(
        buildResponse([
          { text: 'Primero leo el documento...', thought: true },
          { text: CONTRACT },
        ]),
      );
      const provider = buildProvider(http);

      // 2. Act ⚙️
      const result = await provider.generateCompletion('Transcribe.');

      // 3. Assert 🎯
      expect(result.headline).toBe('Titular');
    });

    it('4.4 deberia nombrar el corte por tope en vez de acusar al contrato', async () => {
      // 1. Arrange 📐: es el incidente. El tope cubre tambien el pensamiento,
      //    asi que la respuesta sale a medias y `JSON.parse` falla con
      //    "Unterminated string" — un mensaje que manda a revisar el prompt
      //    cuando lo que falta es presupuesto.
      const http = httpReturning(
        buildResponse(
          [{ text: '{"headline":"Titular","summary":"Resu' }],
          'MAX_TOKENS',
          { thoughtsTokenCount: 960 },
        ),
      );
      const provider = buildProvider(http);

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(
        provider.generateCompletion('Transcribe.', undefined, {
          model: 'gemini-3.6-flash',
          timeoutMs: 30_000,
          maxRetries: 2,
          maxTokens: 4_096,
        }),
      ).rejects.toMatchObject({ code: ERR_LLM_PROVIDER_TRUNCATED });

      await expect(
        provider.generateCompletion('Transcribe.', undefined, {
          model: 'gemini-3.6-flash',
          timeoutMs: 30_000,
          maxRetries: 2,
          maxTokens: 4_096,
        }),
      ).rejects.toThrow(/MAX_TOKENS.*4096.*960/s);
    });

    it('4.5 deberia seguir distinguiendo una respuesta vacia', async () => {
      // 1. Arrange 📐: sin texto no hay nada que truncar; el diagnostico es
      //    otro y el codigo tambien.
      const http = httpReturning(buildResponse([], 'SAFETY'));
      const provider = buildProvider(http);

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(
        provider.generateCompletion('Transcribe.'),
      ).rejects.toMatchObject({ code: ERR_LLM_PROVIDER_CONTRACT });
    });
  });
});
