import { describe, expect, it, jest } from '@jest/globals';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { LlmProvider } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import { LlmProviderFactory } from '@modules/nodes/strategies/llm-provider.factory';
import { MockLlmProvider } from '@modules/nodes/strategies/providers/mock-llm.provider';
import { GeminiProviderException } from '@modules/nodes/strategies/providers/gemini-llm.provider';
import {
  ERR_HTTP_CLIENT_REJECTED,
  ERR_HTTP_UPSTREAM_UNAVAILABLE,
} from '@core/http/http-client.service';
import {
  DEFAULT_OCR_MAX_TOKENS,
  DEFAULT_OCR_MODEL,
  OCR_RETRY_BASE_DELAY_MS,
  PROMPT_OCR_MULTIMODAL,
} from '@modules/nodes/dto/ocr-processor-config.dto';
import {
  ERR_OCR_CONFIG,
  ERR_OCR_EMPTY_TRANSCRIPTION,
  ERR_OCR_NO_ATTACHMENTS,
  ERR_OCR_MAX_RETRIES_EXCEEDED,
  OcrProcessorStrategy,
} from '@modules/nodes/strategies/ocr-processor.strategy';

import { createMockStatePayloadContext } from '../../../../test/factories/state-payload-context.factory';
import { createMockTelemetryService } from '@test/factories/telemetry-service.factory';
import { ERR_TELEMETRY_PERSIST_FAILED } from '@modules/telemetry/telemetry.service';

import type { AiDefaultsConfig } from '@core/config/ai-defaults.config';
import type { AnthropicLlmProvider } from '@modules/nodes/strategies/providers/anthropic-llm.provider';
import type { GeminiLlmProvider } from '@modules/nodes/strategies/providers/gemini-llm.provider';
import type { LlmProviderCatalogService } from '@modules/nodes/services/llm-provider-catalog.service';
import type { LlmResponsePayload } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type { TelemetryService } from '@modules/telemetry/telemetry.service';
import type { TelemetryServiceMock } from '@test/factories/telemetry-service.factory';

/** Adjunto legible por un modelo con vision. */
const SCAN_ATTACHMENT = {
  filename: 'escaneo.png',
  contentType: 'image/png',
  contentBase64: 'QUJDREVG',
};

const buildContext = (
  attachments: readonly unknown[] = [SCAN_ATTACHMENT],
): StatePayloadContext =>
  createMockStatePayloadContext({
    currentStep: 'ocr_ia',
    namespaces: { raw_email: { attachments: [...attachments] } },
  });

/**
 * El mismo adjunto DESPUES de que el motor liberase su binario (RNF-01).
 *
 * Se conservan los metadatos y se anula `contentBase64`, que es literalmente lo
 * que escribe `releaseAttachmentBinaries`.
 */
const PURGED_ATTACHMENT = {
  filename: 'escaneo.png',
  contentType: 'image/png',
  contentBase64: null,
};

/** Transcripcion que una pasada anterior dejo en `ocr_result`. */
const PREVIOUS_TRANSCRIPTION = {
  clean_body: 'Texto transcrito en la pasada anterior.',
  extracted_text: 'Texto transcrito en la pasada anterior.',
  character_count: 39,
  ocr_status: 'COMPLETED',
  processed_at: '2026-10-19T17:30:00.000Z',
  metadata: { provider: LlmProvider.GEMINI, model: 'gemini', isMock: false },
};

/** Contexto de una REANUDACION: binarios liberados y cache a mano o no. */
const buildResumedContext = (
  cached: Record<string, unknown> | null,
): StatePayloadContext =>
  createMockStatePayloadContext({
    currentStep: 'ocr_ia',
    namespaces: {
      raw_email: { attachments: [PURGED_ATTACHMENT] },
      ...(cached === null ? {} : { ocr_result: cached }),
    },
  });

/**
 * Defaults del entorno sin declarar: se cae a las constantes del DTO.
 *
 * Los cuatro metodos devuelven `null` en todos sus campos, que es el escenario
 * de un `.env` que no declara ninguna de las variables `AI_*` ni `OCR_HTTP_*`.
 * Las pruebas que SI ejercen el entorno lo declaran explicitamente por
 * `overrides`.
 */
const buildAiDefaults = (
  overrides: Partial<Record<keyof AiDefaultsConfig, unknown>> = {},
): AiDefaultsConfig =>
  ({
    getOcrDefaults: jest.fn().mockReturnValue({ provider: null, model: null }),
    getTextDefaults: jest.fn().mockReturnValue({ provider: null, model: null }),
    getOcrHttpDefaults: jest
      .fn()
      .mockReturnValue({ timeoutMs: null, maxRetries: null }),
    getTextHttpDefaults: jest
      .fn()
      .mockReturnValue({ timeoutMs: null, maxRetries: null }),
    ...overrides,
  }) as unknown as AiDefaultsConfig;

/**
 * Factoria REAL con los clientes doblados.
 *
 * Se construye la factoria de verdad en vez de doblarla: su unica logica es un
 * mapeo, y un doble devolveria lo que se le dijera, con lo que la prueba
 * dejaria de notar que un proveedor desaparece del indice. Lo que si va
 * doblado es Gemini, que sale a la red; `AnthropicLlmProvider` va vacio porque
 * las pruebas de este nodo no lo ejercen.
 */
const buildProviderFactory = (
  mock: MockLlmProvider,
  gemini: Partial<GeminiLlmProvider>,
  anthropic: Partial<AnthropicLlmProvider> = {},
): LlmProviderFactory => {
  const factory = new LlmProviderFactory(
    mock,
    gemini as GeminiLlmProvider,
    anthropic as AnthropicLlmProvider,
  );

  jest.spyOn(factory['logger'], 'warn').mockImplementation(() => undefined);

  return factory;
};

/**
 * Catalogo doblado: que proveedores tienen credencial en "este entorno".
 *
 * Por defecto TODOS la tienen, de modo que la cascada no se dispara y las
 * pruebas que no la ejercen miden lo mismo que antes de existir. Las que si la
 * ejercen declaran explicitamente quien se queda sin clave.
 */
const buildProviderCatalog = (
  usableProviders: readonly LlmProvider[] = Object.values(LlmProvider),
): LlmProviderCatalogService =>
  ({
    isProviderUsable: jest
      .fn()
      .mockImplementation((provider: LlmProvider) =>
        usableProviders.includes(provider),
      ),
  }) as unknown as LlmProviderCatalogService;

/** Doble de proveedor que responde siempre lo mismo, para la cascada. */
const buildSpyGeminiForCascade = (): jest.Mock<
  () => Promise<LlmResponsePayload>
> =>
  jest.fn<() => Promise<LlmResponsePayload>>(() =>
    Promise.resolve({
      headline: 'Transcripcion',
      summary: 'Texto',
      body_paragraphs: ['Contenido'],
      metadata: {
        tokensPrompt: 1,
        tokensCompletion: 2,
        modelUsed: 'modelo',
        isMock: false,
      },
    }),
  );

const buildStrategy = (
  gemini: Partial<GeminiLlmProvider> = {},
  aiDefaults: AiDefaultsConfig = buildAiDefaults(),
  anthropic: Partial<AnthropicLlmProvider> = {},
  providerCatalog: LlmProviderCatalogService = buildProviderCatalog(),
  telemetry: TelemetryServiceMock = createMockTelemetryService(),
): OcrProcessorStrategy => {
  const mockProvider = new MockLlmProvider();
  const strategy = new OcrProcessorStrategy(
    mockProvider,
    buildProviderFactory(mockProvider, gemini, anthropic),
    aiDefaults,
    providerCatalog,
    telemetry as unknown as TelemetryService,
  );

  jest.spyOn(strategy['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(strategy['logger'], 'warn').mockImplementation(() => undefined);

  return strategy;
};

describe('OcrProcessorStrategy · nodo satelite PROCESADOR_OCR', () => {
  describe('1. Identidad y contrato', () => {
    it('1.1 deberia declararse como PROCESADOR_OCR', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const strategy = buildStrategy();

      // 3. Assert 🎯: la fabrica indexa por este valor; equivocarlo registraria
      //    la estrategia bajo otro tipo y el nodo quedaria sin ejecutor.
      expect(strategy.nodeType).toBe(NodeType.PROCESADOR_OCR);
    });

    it('1.2 deberia publicar extracted_text, para que el motor libere los binarios', () => {
      // 1. Arrange 📐: quien esta en `EXTRACTED_TEXT_KEYS` del motor es
      //    `extracted_text`, no `clean_body`. El parser publica un `clean_body`
      //    con el cuerpo del correo sin haber tocado los adjuntos, asi que esa
      //    clave dejo de acreditar que un binario sobra. `clean_body` se
      //    mantiene porque es lo que interpolan los nodos de aguas abajo.
      const strategy = buildStrategy();

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(strategy.outputFields.map((field) => field.name)).toEqual([
        'clean_body',
        'extracted_text',
        'character_count',
        'ocr_status',
        'processed_at',
        'metadata',
      ]);
    });

    it('1.2b deberia fechar la transcripcion con una marca propia', async () => {
      // 1. Arrange 📐: `processed_at` NO se deriva del checkpoint de la fila.
      //    Una reanudacion reescribe `fecha_actualizacion`, asi que leer de ahi
      //    cuando se transcribio daria la hora del ultimo reintento del flujo.
      const strategy = buildStrategy();

      // 2. Act ⚙️: con el simulador declarado, como el resto del bloque —el
      //    defecto del DTO es GEMINI desde PROT-22—.
      const result = await strategy.execute(buildContext(), {
        provider: LlmProvider.MOCK,
      });

      // 3. Assert 🎯
      expect(typeof result.data?.processed_at).toBe('string');
      expect(Number.isNaN(Date.parse(String(result.data?.processed_at)))).toBe(
        false,
      );
    });

    it('1.3 deberia repetir la transcripcion en clean_body y extracted_text', async () => {
      // 1. Arrange 📐: la duplicacion es deliberada y hay que fijarla. Si
      //    alguien la deshiciera, el motor dejaria de liberar los megabytes del
      //    correo y nada mas en esta suite lo delataria.
      const strategy = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        provider: LlmProvider.MOCK,
      });

      // 3. Assert 🎯
      expect(result.data?.extracted_text).toBe(result.data?.clean_body);
      expect(String(result.data?.extracted_text).length).toBeGreaterThan(0);
    });
  });

  /**
   * Estas pruebas DECLARAN `provider: MOCK` en vez de pasar `{}`.
   *
   * Hasta PROT-22 el defecto del DTO era `MOCK` y un `params` vacio bastaba
   * para simular. Ahora el defecto es `GEMINI` —un nodo que simulaba en
   * silencio publicaba texto inventado como transcripcion—, asi que pedir el
   * simulador es algo que hay que decir.
   */
  describe('2. Transcripcion con el simulador', () => {
    it('2.1 deberia devolver la transcripcion determinista', async () => {
      // 1. Arrange 📐
      const strategy = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        provider: LlmProvider.MOCK,
      });

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.data?.clean_body).toBe(
        '[TRANSCRIPCIÓN MOCK OCR]: Texto recuperado de imagen adjunta.',
      );
      expect(result.data?.ocr_status).toBe('COMPLETED');
    });

    it('2.2 deberia DERIVAR character_count del texto, no fijarlo', async () => {
      // 1. Arrange 📐: un numero escrito a mano se convierte en mentira a la
      //    primera edicion del texto.
      const strategy = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        provider: LlmProvider.MOCK,
      });

      // 3. Assert 🎯
      expect(result.data?.character_count).toBe(
        String(result.data?.clean_body).length,
      );
    });

    it('2.3 NO deberia vetar la purga de binarios', async () => {
      // 1. Arrange 📐: `requires_multimodal_fallback` es el veto que impide al
      //    motor tirar los megabytes del correo. Levantarlo aqui los conservaria
      //    para siempre justo cuando ya se han usado (RNF-01).
      const strategy = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        provider: LlmProvider.MOCK,
      });

      // 3. Assert 🎯
      expect(result.data?.requires_multimodal_fallback).toBeUndefined();
    });
  });

  describe('3. Seleccion de adjuntos', () => {
    it('3.1 deberia descartar los que no tienen binario o no son visuales', async () => {
      // 1. Arrange 📐: pedirle a un modelo con vision que lea un `.xlsx` no lo
      //    arregla, y pagarlo seria tirar el dinero dos veces. El base64 puede
      //    venir en `null` porque el motor ya lo libero en un paso anterior.
      const generateCompletion = jest.fn<() => Promise<LlmResponsePayload>>();
      generateCompletion.mockResolvedValue({
        headline: 'h',
        summary: 'Texto transcrito del unico adjunto legible del correo.',
        body_paragraphs: [],
        metadata: {
          tokensPrompt: 0,
          tokensCompletion: 0,
          modelUsed: 'gemini-3.6-flash',
          isMock: false,
        },
      });
      const strategy = buildStrategy({
        provider: LlmProvider.GEMINI,
        generateCompletion,
      } as unknown as GeminiLlmProvider);

      // 2. Act ⚙️
      await strategy.execute(
        buildContext([
          {
            filename: 'hoja.xlsx',
            contentType: 'application/vnd.ms-excel',
            contentBase64: 'QQ==',
          },
          {
            filename: 'liberado.png',
            contentType: 'image/png',
            contentBase64: null,
          },
          SCAN_ATTACHMENT,
        ]),
        { provider: LlmProvider.GEMINI },
      );

      // 3. Assert 🎯: solo sobrevive el escaneo.
      const attachments = generateCompletion.mock.calls[0]?.[3] as
        readonly { filename: string }[] | undefined;

      expect(attachments).toHaveLength(1);
      expect(attachments?.[0]?.filename).toBe('escaneo.png');
    });

    it('3.2 deberia FALLAR como GRAVE si no queda ningun adjunto', async () => {
      // 1. Arrange 📐: a este nodo solo se llega por una ruta de contingencia.
      //    Si el rescate no puede hacerse, el correo se queda sin contenido y
      //    alguien tiene que mirarlo.
      const strategy = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext([]), {});

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_OCR_NO_ATTACHMENTS);
      expect(result.error?.missingFields).toEqual(['raw_email.attachments']);
    });
  });

  describe('4. Fallos', () => {
    it('4.1 deberia rechazar un param fuera del contrato', async () => {
      // 1. Arrange 📐: `forbidNonWhitelisted`. Aceptarlo lo guardaria en el
      //    esquema sin que nada lo leyera nunca.
      const strategy = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        templatePromptId: 'a7b8c9d0-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
      });

      // 3. Assert 🎯: el prompt de este nodo es del sistema y no se elige.
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_OCR_CONFIG);
    });

    it('4.2 deberia traducir un fallo del proveedor a GRAVE', async () => {
      // 1. Arrange 📐: dejar salir la excepcion la normalizaria el motor a
      //    URGENTE, que `canRetry` nunca reintenta.
      const generateCompletion = jest.fn<() => Promise<LlmResponsePayload>>();
      generateCompletion.mockRejectedValue(
        new Error('el proveedor no responde'),
      );
      const strategy = buildStrategy({
        provider: LlmProvider.GEMINI,
        generateCompletion,
      } as unknown as GeminiLlmProvider);

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_OCR_MAX_RETRIES_EXCEEDED);

      // Un unico fallo consolidado: al llegar aqui ya corrieron los reintentos
      // del transporte y la cascada de proveedores entera, de modo que el
      // presupuesto se declara agotado para que el motor no sume los suyos.
      expect(result.error?.metadata).toMatchObject({ exhausted: true });
      expect(result.error?.description).toContain('Causa raiz');
    });

    it('4.3 NO deberia publicar una transcripcion vacia como exito', async () => {
      // 1. Arrange 📐: dejaria `clean_body` en blanco, el motor no liberaria los
      //    binarios —no hay texto util— y el nodo de redaccion recibiria un
      //    contexto que parece bueno y no lo es.
      const generateCompletion = jest.fn<() => Promise<LlmResponsePayload>>();
      generateCompletion.mockResolvedValue({
        headline: '',
        summary: '   ',
        body_paragraphs: [],
        metadata: {
          tokensPrompt: 0,
          tokensCompletion: 0,
          modelUsed: 'gemini-3.6-flash',
          isMock: false,
        },
      });
      const strategy = buildStrategy({
        provider: LlmProvider.GEMINI,
        generateCompletion,
      } as unknown as GeminiLlmProvider);

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_OCR_EMPTY_TRANSCRIPTION);
    });
  });

  describe('5. Resolucion del proveedor', () => {
    it('5.1 deberia usar el cliente de ANTHROPIC y no degradar al simulador', async () => {
      // 1. Arrange 📐: REGRESION de PROT-21. Este nodo resolvia el proveedor
      //    con una copia propia del mapeo que nunca llego a conocer
      //    `ANTHROPIC`, asi que un OCR configurado con Claude caia al
      //    simulador aunque el cliente existiera desde PROT-20 — y lo hacia
      //    por la misma via que un proveedor inexistente, indistinguible en
      //    el log. Ahora el mapeo lo resuelve `LlmProviderFactory`.
      const generateCompletion = jest.fn<() => Promise<LlmResponsePayload>>(
        () =>
          Promise.resolve({
            headline: 'Transcripcion',
            summary: 'Texto recuperado del escaneo',
            body_paragraphs: ['Contenido del documento'],
            metadata: {
              tokensPrompt: 10,
              tokensCompletion: 20,
              modelUsed: 'claude-sonnet-5-5',
              isMock: false,
            },
          }),
      );
      const strategy = buildStrategy({}, buildAiDefaults(), {
        provider: LlmProvider.ANTHROPIC,
        generateCompletion,
      } as unknown as AnthropicLlmProvider);

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        provider: LlmProvider.ANTHROPIC,
      });

      // 3. Assert 🎯: respondio el cliente doblado y no el simulador. Desde
      //    PROT-22 hay dos senales y se comprueban las dos: el texto
      //    transcrito y el `isMock` del namespace, que antes se descartaba.
      expect(generateCompletion).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.data?.clean_body).not.toContain('MOCK OCR');
      expect(
        (result.data?.metadata as { isMock?: boolean } | undefined)?.isMock,
      ).toBe(false);
    });

    it('5.2 deberia seguir degradando al simulador un proveedor sin cliente', async () => {
      // 1. Arrange 📐: OPENAI es el unico que queda sin cliente. La
      //    degradacion se conserva a proposito (criterio de PROT-16).
      const strategy = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        provider: LlmProvider.OPENAI,
      });

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.data?.clean_body).toContain('MOCK OCR');
    });
  });

  describe('6. Presupuesto de la llamada', () => {
    /** Doble que solo sirve para capturar las opciones con que se le llama. */
    const buildSpyGemini = (): jest.Mock<() => Promise<LlmResponsePayload>> =>
      jest.fn<() => Promise<LlmResponsePayload>>(() =>
        Promise.resolve({
          headline: 'Transcripcion',
          summary: 'Texto',
          body_paragraphs: ['Contenido del documento'],
          metadata: {
            tokensPrompt: 1,
            tokensCompletion: 2,
            modelUsed: 'gemini-3.6-flash',
            isMock: false,
          },
        }),
      );

    it('6.1 deberia enviar la temperatura al proveedor', async () => {
      // 1. Arrange 📐: hasta PROT-22 el DTO resolvia 0.1 para transcribir con
      //    fidelidad y la estrategia no lo pasaba a ninguna parte, asi que
      //    todas las transcripciones corrian con el defecto del modelo.
      const generateCompletion = buildSpyGemini();
      const strategy = buildStrategy({
        provider: LlmProvider.GEMINI,
        generateCompletion,
      } as unknown as GeminiLlmProvider);

      // 2. Act ⚙️
      await strategy.execute(buildContext(), { provider: LlmProvider.GEMINI });

      // 3. Assert 🎯
      const options = generateCompletion.mock.calls[0]?.[2] as
        | {
            temperature?: number;
            maxTokens?: number;
            thinkingLevel?: string;
          }
        | undefined;

      expect(options?.temperature).toBe(0.1);
      // Contra la CONSTANTE: el valor sube cuando sube el presupuesto, y un
      // literal aqui convertiria ese cambio en una prueba roja sin informacion.
      expect(options?.maxTokens).toBe(DEFAULT_OCR_MAX_TOKENS);
    });

    it('6.0 deberia transcribir con el prompt por defecto si el nodo no declara otro', async () => {
      // 1. Arrange 📐
      const generateCompletion = buildSpyGemini();
      const strategy = buildStrategy({
        provider: LlmProvider.GEMINI,
        generateCompletion,
      } as unknown as GeminiLlmProvider);

      // 2. Act ⚙️
      await strategy.execute(buildContext(), { provider: LlmProvider.GEMINI });

      // 3. Assert 🎯
      const [prompt] = generateCompletion.mock.calls[0] as unknown[];
      expect(prompt).toBe(PROMPT_OCR_MULTIMODAL);
    });

    it('6.0bis deberia usar el customPrompt del nodo, recortado, en lugar del por defecto', async () => {
      // 1. Arrange 📐: el flujo pide ignorar los sellos del documento.
      const generateCompletion = buildSpyGemini();
      const strategy = buildStrategy({
        provider: LlmProvider.GEMINI,
        generateCompletion,
      } as unknown as GeminiLlmProvider);

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        provider: LlmProvider.GEMINI,
        customPrompt: '  Transcribe el documento ignorando sellos y firmas.  ',
      });

      // 3. Assert 🎯: el contrato JSON lo sigue poniendo el proveedor.
      const [prompt] = generateCompletion.mock.calls[0] as unknown[];
      expect(result.success).toBe(true);
      expect(prompt).toBe('Transcribe el documento ignorando sellos y firmas.');
    });

    it('6.0ter deberia rechazar un customPrompt vacio como configuracion invalida', async () => {
      // 1. Arrange 📐
      const generateCompletion = buildSpyGemini();
      const strategy = buildStrategy({
        provider: LlmProvider.GEMINI,
        generateCompletion,
      } as unknown as GeminiLlmProvider);

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        provider: LlmProvider.GEMINI,
        customPrompt: '',
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_OCR_CONFIG);
      expect(generateCompletion).not.toHaveBeenCalled();
    });

    it('6.1bis deberia pedir el pensamiento MINIMO para transcribir', async () => {
      // 1. Arrange 📐: en Gemini 3.x lo que el modelo piensa sale del mismo
      //    presupuesto que lo que escribe. Con el tope en 4096 gastaba ~1000
      //    deliberando y la transcripcion salia cortada a media cadena JSON.
      const generateCompletion = buildSpyGemini();
      const strategy = buildStrategy({
        provider: LlmProvider.GEMINI,
        generateCompletion,
      } as unknown as GeminiLlmProvider);

      // 2. Act ⚙️
      await strategy.execute(buildContext(), { provider: LlmProvider.GEMINI });

      // 3. Assert 🎯
      const options = generateCompletion.mock.calls[0]?.[2] as
        { thinkingLevel?: string } | undefined;

      expect(options?.thinkingLevel).toBe('minimal');
    });

    it('6.1ter deberia trasladar la espera y los reintentos del entorno', async () => {
      // 1. Arrange 📐: `OCR_HTTP_*` va aparte de `LLM_HTTP_*` por el mismo
      //    motivo que `AI_OCR_DEFAULT_*` va aparte de `AI_DEFAULT_*`:
      //    transcribir no es redactar, y una transcripcion no crece con el
      //    numero de filas de la tabla como lo hace una redaccion.
      const generateCompletion = buildSpyGemini();
      const strategy = buildStrategy(
        {
          provider: LlmProvider.GEMINI,
          generateCompletion,
        } as unknown as GeminiLlmProvider,
        buildAiDefaults({
          getOcrHttpDefaults: jest
            .fn()
            .mockReturnValue({ timeoutMs: 45_000, maxRetries: 0 }),
        }),
      );

      // 2. Act ⚙️
      await strategy.execute(buildContext(), { provider: LlmProvider.GEMINI });

      // 3. Assert 🎯
      // El doble se tipa con una firma sin argumentos, asi que indexar la
      // tupla de la llamada exige reinterpretarla. Las pruebas vecinas lo
      // hacen sobre `calls[0]?.[2]` directamente y eso deja un error de tipos
      // en la linea; aqui se reinterpreta el arreglo entero para no sumar otro.
      const options = (
        generateCompletion.mock.calls as unknown as readonly [
          unknown,
          unknown,
          Record<string, unknown>,
        ][]
      )[0]?.[2];

      expect(options).toMatchObject({
        timeoutMs: 45_000,
        maxRetries: 0,
        baseDelayMs: OCR_RETRY_BASE_DELAY_MS,
      });
    });

    it('6.2 deberia respetar la temperatura declarada en el nodo', async () => {
      // 1. Arrange 📐
      const generateCompletion = buildSpyGemini();
      const strategy = buildStrategy({
        provider: LlmProvider.GEMINI,
        generateCompletion,
      } as unknown as GeminiLlmProvider);

      // 2. Act ⚙️
      await strategy.execute(buildContext(), {
        provider: LlmProvider.GEMINI,
        temperature: 0.7,
      });

      // 3. Assert 🎯
      const options = generateCompletion.mock.calls[0]?.[2] as
        { temperature?: number } | undefined;

      expect(options?.temperature).toBe(0.7);
    });

    it('6.3 deberia recortar los adjuntos con allowedMimeTypes', async () => {
      // 1. Arrange 📐: el nodo puede estrechar la lista por defecto cuando se
      //    sabe que los PDF de ese buzon no son escaneos sino facturas.
      const generateCompletion = buildSpyGemini();
      const strategy = buildStrategy({
        provider: LlmProvider.GEMINI,
        generateCompletion,
      } as unknown as GeminiLlmProvider);
      const context = buildContext([
        SCAN_ATTACHMENT,
        {
          filename: 'contrato.pdf',
          contentType: 'application/pdf',
          contentBase64: 'UERGMQ==',
        },
      ]);

      // 2. Act ⚙️
      await strategy.execute(context, {
        provider: LlmProvider.GEMINI,
        allowedMimeTypes: ['image/png'],
      });

      // 3. Assert 🎯: el PDF, que el patron por defecto si admite, se queda
      //    fuera porque el nodo lo excluyo.
      const attachments = generateCompletion.mock.calls[0]?.[3] as
        readonly { contentType: string }[] | undefined;

      expect(attachments).toHaveLength(1);
      expect(attachments?.[0]?.contentType).toBe('image/png');
    });

    it('6.4 NO deberia admitir un tipo que el proveedor no entiende', async () => {
      // 1. Arrange 📐: `allowedMimeTypes` solo puede RECORTAR. Declarar
      //    `text/csv` colaria un adjunto que el proveedor rechazaria con un
      //    error que nadie sabria leer.
      const generateCompletion = buildSpyGemini();
      const strategy = buildStrategy({
        provider: LlmProvider.GEMINI,
        generateCompletion,
      } as unknown as GeminiLlmProvider);
      const context = buildContext([
        {
          filename: 'datos.csv',
          contentType: 'text/csv',
          contentBase64: 'YSxiLGM=',
        },
      ]);

      // 2. Act ⚙️
      const result = await strategy.execute(context, {
        provider: LlmProvider.GEMINI,
        allowedMimeTypes: ['text/csv'],
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_OCR_NO_ATTACHMENTS);
      expect(generateCompletion).not.toHaveBeenCalled();
    });
  });

  describe('7. Cascada entre proveedores', () => {
    it('7.1 deberia conmutar a ANTHROPIC cuando falta la clave de GEMINI', async () => {
      // 1. Arrange 📐: cada cliente degrada al simulador si le falta SU clave,
      //    y eso dejaba un hueco concreto: un entorno con ANTHROPIC_API_KEY y
      //    sin GEMINI_API_KEY transcribia con el simulador —texto inventado
      //    publicado como transcripcion— teniendo un proveedor real a mano.
      const generateCompletion = jest.fn<() => Promise<LlmResponsePayload>>(
        () =>
          Promise.resolve({
            headline: 'Transcripcion',
            summary: 'Texto',
            body_paragraphs: ['Contenido real'],
            metadata: {
              tokensPrompt: 1,
              tokensCompletion: 2,
              modelUsed: 'claude-haiku-4-5',
              isMock: false,
            },
          }),
      );
      const strategy = buildStrategy(
        {},
        buildAiDefaults(),
        {
          provider: LlmProvider.ANTHROPIC,
          generateCompletion,
        } as unknown as AnthropicLlmProvider,
        buildProviderCatalog([LlmProvider.ANTHROPIC, LlmProvider.MOCK]),
      );

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert 🎯: y el MODELO cambia con el proveedor. Arrastrar
      //    `gemini-3.6-flash` a Anthropic daria un 404 que parece un fallo de
      //    red.
      expect(generateCompletion).toHaveBeenCalledTimes(1);
      expect(
        (
          generateCompletion.mock.calls[0]?.[2] as
            { model?: string } | undefined
        )?.model,
      ).toBe('claude-haiku-4-5');
      expect(result.data?.clean_body).toBe('Contenido real');
    });

    it('7.2 NO deberia conmutar si no hay ninguna credencial alternativa', async () => {
      // 1. Arrange 📐: sin un segundo proveedor usable la cascada no tiene a
      //    donde saltar y deja el proveedor pedido intacto. Quien degrada
      //    entonces es el propio cliente, que al no encontrar su clave delega
      //    en el simulador —comportamiento de PROT-16 que esta capa no toca—.
      //    Aqui se fija justamente eso: que la cascada no se invente un salto.
      const geminiCompletion = buildSpyGeminiForCascade();
      const anthropicCompletion = buildSpyGeminiForCascade();
      const strategy = buildStrategy(
        {
          provider: LlmProvider.GEMINI,
          generateCompletion: geminiCompletion,
        } as unknown as GeminiLlmProvider,
        buildAiDefaults(),
        {
          provider: LlmProvider.ANTHROPIC,
          generateCompletion: anthropicCompletion,
        } as unknown as AnthropicLlmProvider,
        buildProviderCatalog([LlmProvider.MOCK]),
      );

      // 2. Act ⚙️
      await strategy.execute(buildContext(), {
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert 🎯: sigue yendo a Gemini con su modelo, no a Anthropic. Se
      //    compara contra la CONSTANTE y no contra un literal: el identificador
      //    caduca cuando Google retira el modelo, y un literal aqui dejaria la
      //    prueba en verde mientras produccion recibe 404.
      expect(anthropicCompletion).not.toHaveBeenCalled();
      expect(
        (geminiCompletion.mock.calls[0]?.[2] as { model?: string } | undefined)
          ?.model,
      ).toBe(DEFAULT_OCR_MODEL);
    });

    it('7.4 deberia publicar isMock cuando responde el simulador', async () => {
      // 1. Arrange 📐: el motivo por el que `metadata` sale al namespace. Sin
      //    esto, una transcripcion simulada y una real son indistinguibles
      //    aguas abajo y la noticia se publica con texto inventado.
      const strategy = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        provider: LlmProvider.MOCK,
      });

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(
        (result.data?.metadata as { isMock?: boolean } | undefined)?.isMock,
      ).toBe(true);
    });

    it('7.3 NO deberia conmutar cuando el proveedor pedido si tiene clave', async () => {
      // 1. Arrange 📐
      const geminiCompletion = buildSpyGeminiForCascade();
      const anthropicCompletion = buildSpyGeminiForCascade();
      const strategy = buildStrategy(
        {
          provider: LlmProvider.GEMINI,
          generateCompletion: geminiCompletion,
        } as unknown as GeminiLlmProvider,
        buildAiDefaults(),
        {
          provider: LlmProvider.ANTHROPIC,
          generateCompletion: anthropicCompletion,
        } as unknown as AnthropicLlmProvider,
        buildProviderCatalog([LlmProvider.GEMINI, LlmProvider.ANTHROPIC]),
      );

      // 2. Act ⚙️
      await strategy.execute(buildContext(), { provider: LlmProvider.GEMINI });

      // 3. Assert 🎯
      expect(geminiCompletion).toHaveBeenCalledTimes(1);
      expect(anthropicCompletion).not.toHaveBeenCalled();
    });
  });

  describe('8. Transcripcion en Markdown', () => {
    /** Construye una estrategia cuyo proveedor devuelve estos parrafos. */
    const buildStrategyReturning = (
      bodyParagraphs: string[],
      summary = 'resumen',
    ): OcrProcessorStrategy => {
      const generateCompletion = jest.fn<() => Promise<LlmResponsePayload>>();

      generateCompletion.mockResolvedValue({
        headline: 'h',
        summary,
        body_paragraphs: bodyParagraphs,
        metadata: {
          tokensPrompt: 0,
          tokensCompletion: 0,
          modelUsed: 'gemini-3.6-flash',
          isMock: false,
        },
      });

      return buildStrategy({
        provider: LlmProvider.GEMINI,
        generateCompletion,
      } as unknown as GeminiLlmProvider);
    };

    const transcribe = async (
      bodyParagraphs: string[],
      summary?: string,
    ): Promise<string> => {
      const strategy = buildStrategyReturning(bodyParagraphs, summary);
      const result = await strategy.execute(buildContext(), {
        provider: LlmProvider.GEMINI,
      });

      return String(result.data?.clean_body);
    };

    it('8.1 deberia conservar titulos y lineas en blanco del texto corrido', async () => {
      // 1. Arrange 📐: el caso facil, y el que no debe romperse al arreglar el
      //    de las tablas.
      const markdown =
        '## Acta de la sesion\n\nPrimer parrafo.\n\nSegundo parrafo.';

      // 2. Act ⚙️
      const cleanBody = await transcribe([markdown]);

      // 3. Assert 🎯
      expect(cleanBody).toBe(markdown);
    });

    it('8.2 deberia conservar una tabla GFM entregada en un solo bloque', async () => {
      // 1. Arrange 📐: es lo que el prompt pide expresamente (directiva 3).
      const table = [
        '| Centro | Panel |',
        '| --- | --- |',
        '| UEM | P-01 |',
      ].join('\n');

      // 2. Act ⚙️
      const cleanBody = await transcribe([table]);

      // 3. Assert 🎯
      expect(cleanBody).toBe(table);
    });

    it('8.3 deberia reensamblar una tabla troceada SIN lineas en blanco', async () => {
      // 1. Arrange 📐: LA PRUEBA QUE DE VERDAD PROTEGE. Si el modelo desobedece
      //    la directiva 3 y manda una fila por elemento, la union de siempre
      //    —linea en blanco— separaria el `|---|` de las filas y GFM dejaria de
      //    reconocer la tabla. Y no hay vuelta atras: cuando el motor ve texto
      //    util libera los binarios del adjunto.
      const rows = ['| Centro | Panel |', '| --- | --- |', '| UEM | P-01 |'];

      // 2. Act ⚙️
      const cleanBody = await transcribe(rows);

      // 3. Assert 🎯
      expect(cleanBody).toBe(rows.join('\n'));
      expect(cleanBody).not.toContain('\n\n');
    });

    it('8.4 deberia purgar la valla de bloque que envuelve la respuesta', async () => {
      // 1. Arrange 📐: el prompt se lo prohibe al modelo, pero una valla que se
      //    cuele acaba publicada tal cual: nada mas abajo vuelve a mirar el
      //    texto.
      // 2. Act ⚙️
      const cleanBody = await transcribe([
        '```markdown\n# Titulo\n\nCuerpo del documento.\n```',
      ]);

      // 3. Assert 🎯
      expect(cleanBody).toBe('# Titulo\n\nCuerpo del documento.');
      expect(cleanBody).not.toContain('```');
    });

    it('8.5 deberia purgar una valla REPARTIDA entre el primer y el ultimo bloque', async () => {
      // 1. Arrange 📐: con la salida troceada, la apertura viene en un elemento
      //    y el cierre en otro. Un unico regex sobre la cadena ya unida solo
      //    acertaria cuando el arreglo trae un elemento.
      // 2. Act ⚙️
      const cleanBody = await transcribe([
        '```markdown',
        '| Centro | Panel |',
        '| --- | --- |',
        '```',
      ]);

      // 3. Assert 🎯
      expect(cleanBody).not.toContain('```');
      expect(cleanBody).toBe('| Centro | Panel |\n| --- | --- |');
    });

    it('8.6 NO deberia pegar dos parrafos que no son tabla', async () => {
      // 1. Arrange 📐: la union consciente de tablas no puede llevarse por
      //    delante la separacion normal de parrafos.
      // 2. Act ⚙️
      const cleanBody = await transcribe([
        'Primer parrafo.',
        'Segundo parrafo.',
      ]);

      // 3. Assert 🎯
      expect(cleanBody).toBe('Primer parrafo.\n\nSegundo parrafo.');
    });

    it('8.7 deberia derivar character_count del texto YA saneado', async () => {
      // 1. Arrange 📐: contarlo sobre el crudo inflaria la cifra con unos
      //    delimitadores que no estan en la transcripcion.
      const strategy = buildStrategyReturning(['```\nABC\n```']);

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert 🎯
      expect(result.data?.clean_body).toBe('ABC');
      expect(result.data?.character_count).toBe(3);
    });

    it('8.8 deberia sanear tambien el respaldo por summary', async () => {
      // 1. Arrange 📐: sin parragos se cae al resumen, y ese camino tenia que
      //    quedar igual de limpio que el principal.
      // 2. Act ⚙️
      const cleanBody = await transcribe(
        [],
        '```markdown\nTexto del resumen\n```',
      );

      // 3. Assert 🎯
      expect(cleanBody).toBe('Texto del resumen');
    });
  });

  describe('9. Respaldo dinamico ante un proveedor saturado', () => {
    /** Cliente que revienta con el codigo que le pasemos. */
    const buildThrowingProvider = (
      code: string,
    ): jest.Mock<() => Promise<LlmResponsePayload>> =>
      jest.fn<() => Promise<LlmResponsePayload>>(() =>
        Promise.reject(
          new GeminiProviderException(`${code}: el remoto no atiende`, code),
        ),
      );

    it('9.1 deberia conmutar a ANTHROPIC ante un 429 de cuota', async () => {
      // 1. Arrange 📐: el incidente real. La credencial de Gemini esta puesta,
      //    asi que la cascada por credencial ausente no se dispara: el nodo
      //    llamaba, recibia el 429 y se rendia con una alternativa viva al lado.
      const geminiCompletion = buildThrowingProvider(
        ERR_HTTP_UPSTREAM_UNAVAILABLE,
      );
      const anthropicCompletion = buildSpyGeminiForCascade();
      const strategy = buildStrategy(
        {
          provider: LlmProvider.GEMINI,
          generateCompletion: geminiCompletion,
        } as unknown as GeminiLlmProvider,
        buildAiDefaults(),
        {
          provider: LlmProvider.ANTHROPIC,
          generateCompletion: anthropicCompletion,
        } as unknown as AnthropicLlmProvider,
      );

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert 🎯
      expect(geminiCompletion).toHaveBeenCalledTimes(1);
      expect(anthropicCompletion).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      // El rastro: sin el, una transcripcion pagada en Anthropic seria
      // indistinguible de una gratuita en Gemini al auditar.
      expect(result.data?.metadata).toMatchObject({
        provider: LlmProvider.ANTHROPIC,
        fallbackFrom: LlmProvider.GEMINI,
      });
    });

    it('9.2 NO deberia conmutar ante un fallo que el destino repetiria', async () => {
      // 1. Arrange 📐: un 400 de payload o una credencial mala fallan igual en
      //    el siguiente proveedor. Conmutar seria pagar dos veces el mismo
      //    error y tardar el doble en avisar.
      const geminiCompletion = buildThrowingProvider(ERR_HTTP_CLIENT_REJECTED);
      const anthropicCompletion = buildSpyGeminiForCascade();
      const strategy = buildStrategy(
        {
          provider: LlmProvider.GEMINI,
          generateCompletion: geminiCompletion,
        } as unknown as GeminiLlmProvider,
        buildAiDefaults(),
        {
          provider: LlmProvider.ANTHROPIC,
          generateCompletion: anthropicCompletion,
        } as unknown as AnthropicLlmProvider,
      );

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert 🎯
      expect(anthropicCompletion).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_OCR_MAX_RETRIES_EXCEEDED);
    });

    it('9.3 deberia rendirse con el ultimo error al agotar la cadena', async () => {
      // 1. Arrange 📐: los dos saturados. El nodo debe FALLAR para que la FSM
      //    resuelva su `onErrorStep` y alguien se entere.
      const geminiCompletion = buildThrowingProvider(
        ERR_HTTP_UPSTREAM_UNAVAILABLE,
      );
      const anthropicCompletion = buildThrowingProvider(
        ERR_HTTP_UPSTREAM_UNAVAILABLE,
      );
      const strategy = buildStrategy(
        {
          provider: LlmProvider.GEMINI,
          generateCompletion: geminiCompletion,
        } as unknown as GeminiLlmProvider,
        buildAiDefaults(),
        {
          provider: LlmProvider.ANTHROPIC,
          generateCompletion: anthropicCompletion,
        } as unknown as AnthropicLlmProvider,
      );

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert 🎯
      expect(geminiCompletion).toHaveBeenCalledTimes(1);
      expect(anthropicCompletion).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
    });

    it('9.4 NO deberia recoger el fallo con el simulador', async () => {
      // 1. Arrange 📐: es la linea que no se cruza. Sin ANTHROPIC_API_KEY, un
      //    429 de Gemini debe terminar en fallo; completar la transcripcion con
      //    el simulador publicaria texto inventado tapando la incidencia.
      const geminiCompletion = buildThrowingProvider(
        ERR_HTTP_UPSTREAM_UNAVAILABLE,
      );
      const anthropicCompletion = buildSpyGeminiForCascade();
      const strategy = buildStrategy(
        {
          provider: LlmProvider.GEMINI,
          generateCompletion: geminiCompletion,
        } as unknown as GeminiLlmProvider,
        buildAiDefaults(),
        {
          provider: LlmProvider.ANTHROPIC,
          generateCompletion: anthropicCompletion,
        } as unknown as AnthropicLlmProvider,
        buildProviderCatalog([LlmProvider.GEMINI]),
      );

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert 🎯
      expect(anthropicCompletion).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.data?.clean_body).toBeUndefined();
    });
  });

  describe('8. Reanudacion con binarios purgados (CU-09 sobre RNF-01)', () => {
    it('8.1 deberia reutilizar la transcripcion previa sin llamar al proveedor', async () => {
      // 1. Arrange 📐: el escenario exacto de reanudar desde `ocr_ia`. El nodo
      //    ya corrio, publico texto util y el motor tiro los binarios; el
      //    operador no puede devolverlos.
      const generateCompletion = jest.fn<() => Promise<LlmResponsePayload>>();
      const strategy = buildStrategy({
        provider: LlmProvider.GEMINI,
        generateCompletion,
      } as unknown as Partial<GeminiLlmProvider>);

      // 2. Act ⚙️
      const result = await strategy.execute(
        buildResumedContext(PREVIOUS_TRANSCRIPTION),
        { provider: LlmProvider.GEMINI },
      );

      // 3. Assert 🎯: sale adelante con lo que ya habia y NO se vuelve a pagar
      //    una transcripcion que ya esta hecha.
      expect(result.success).toBe(true);
      expect(result.data).toEqual(PREVIOUS_TRANSCRIPTION);
      expect(generateCompletion).not.toHaveBeenCalled();
    });

    it('8.2 deberia seguir fallando GRAVE si no hay transcripcion previa', async () => {
      // 1. Arrange 📐: sin binarios Y sin cache no hay nada que hacer. La
      //    salvaguarda no puede tragarse el fallo legitimo de un correo que
      //    nunca trajo adjuntos legibles.
      const generateCompletion = jest.fn<() => Promise<LlmResponsePayload>>();
      const strategy = buildStrategy({
        provider: LlmProvider.GEMINI,
        generateCompletion,
      } as unknown as Partial<GeminiLlmProvider>);

      // 2. Act ⚙️
      const result = await strategy.execute(buildResumedContext(null), {
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_OCR_NO_ATTACHMENTS);
      expect(generateCompletion).not.toHaveBeenCalled();
    });

    it('8.3 deberia ignorar una cache que no llego a COMPLETED', async () => {
      // 1. Arrange 📐: el motor copia el `data` de un resultado fallido en
      //    `error_context.partial_data`, y un flujo puede dejar restos a medias
      //    en el namespace. Reutilizarlos publicaria texto incompleto como si
      //    fuera una transcripcion buena.
      const generateCompletion = jest.fn<() => Promise<LlmResponsePayload>>();
      const strategy = buildStrategy({
        provider: LlmProvider.GEMINI,
        generateCompletion,
      } as unknown as Partial<GeminiLlmProvider>);

      // 2. Act ⚙️
      const result = await strategy.execute(
        buildResumedContext({
          ...PREVIOUS_TRANSCRIPTION,
          ocr_status: 'FAILED',
        }),
        { provider: LlmProvider.GEMINI },
      );

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_OCR_NO_ATTACHMENTS);
    });

    it('8.4 deberia leer la cache del `cacheNamespace` declarado', async () => {
      // 1. Arrange 📐: el nodo no conoce su propio `outputNamespace`, asi que un
      //    flujo que renombre la salida tiene que poder decirselo. Sin este
      //    param, la salvaguarda solo funcionaria con el nombre convencional.
      const strategy = buildStrategy();
      const context = createMockStatePayloadContext({
        currentStep: 'ocr_ia',
        namespaces: {
          raw_email: { attachments: [PURGED_ATTACHMENT] },
          transcripcion: PREVIOUS_TRANSCRIPTION,
        },
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {
        cacheNamespace: 'transcripcion',
      });

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.data).toEqual(PREVIOUS_TRANSCRIPTION);
    });
  });

  describe('10. Telemetria de tokens', () => {
    /** Respuesta real de Gemini con razonamiento facturado aparte. */
    const buildGeminiReply = (
      body: readonly string[] = ['Texto transcrito del escaneo.'],
      summary = 'Texto',
    ): jest.Mock<() => Promise<LlmResponsePayload>> =>
      jest.fn<() => Promise<LlmResponsePayload>>(() =>
        Promise.resolve({
          headline: 'Transcripcion',
          summary,
          body_paragraphs: [...body],
          metadata: {
            tokensPrompt: 2_000,
            tokensCompletion: 300,
            tokensReasoning: 100,
            usageReported: true,
            modelUsed: 'gemini-3.6-flash',
            isMock: false,
          },
        }),
      );

    const buildGeminiStrategy = (
      generateCompletion: jest.Mock<() => Promise<LlmResponsePayload>>,
      telemetry: TelemetryServiceMock,
    ): OcrProcessorStrategy =>
      buildStrategy(
        {
          provider: LlmProvider.GEMINI,
          generateCompletion,
        } as unknown as GeminiLlmProvider,
        buildAiDefaults(),
        {},
        buildProviderCatalog(),
        telemetry,
      );

    it('10.1 deberia publicar en ocr_result.metadata los tokens y el coste estimado', async () => {
      // 1. Arrange 📐
      const telemetry = createMockTelemetryService();
      const strategy = buildGeminiStrategy(buildGeminiReply(), telemetry);

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert 🎯: 2000 x 2 + 300 x 10 + 100 x 10 USD/MTok = 0.008 USD.
      expect(result.success).toBe(true);
      expect(result.data?.metadata).toMatchObject({
        provider: LlmProvider.GEMINI,
        model: 'gemini-3.6-flash',
        tokensPrompt: 2_000,
        tokensCompletion: 300,
        tokensReasoning: 100,
        totalTokens: 2_400,
        estimatedCostUSD: 0.008,
      });
    });

    it('10.2 deberia registrar el consumo con la ejecucion y el nodo del contexto', async () => {
      // 1. Arrange 📐
      const telemetry = createMockTelemetryService();
      const strategy = buildGeminiStrategy(buildGeminiReply(), telemetry);
      const context = buildContext();

      // 2. Act ⚙️
      await strategy.execute(context, { provider: LlmProvider.GEMINI });

      // 3. Assert 🎯
      expect(telemetry.recordTokenUsage).toHaveBeenCalledWith({
        executionId: context.getExecutionId(),
        nodeId: 'ocr_ia',
        aiProvider: LlmProvider.GEMINI,
        aiModel: 'gemini-3.6-flash',
        promptTokens: 2_000,
        completionTokens: 300,
        reasoningTokens: 100,
        usageReported: true,
      });
    });

    it('10.3 deberia pausar con GRAVE si no se puede registrar el consumo', async () => {
      // 1. Arrange 📐
      const telemetry = createMockTelemetryService();
      telemetry.recordTokenUsage.mockRejectedValue(
        new Error('conexion perdida'),
      );
      const strategy = buildGeminiStrategy(buildGeminiReply(), telemetry);

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_TELEMETRY_PERSIST_FAILED);
    });

    it('10.4 deberia registrar el consumo de una transcripcion vacia antes de fallar', async () => {
      // 1. Arrange 📐: el modelo respondio sin texto, pero la llamada se
      //    facturo igual.
      const telemetry = createMockTelemetryService();
      const strategy = buildGeminiStrategy(
        buildGeminiReply([''], ''),
        telemetry,
      );

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert 🎯: primero el registro, despues el GRAVE de siempre.
      expect(telemetry.recordTokenUsage).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_OCR_EMPTY_TRANSCRIPTION);
    });

    it('10.5 no deberia registrar las transcripciones del simulador', async () => {
      // 1. Arrange 📐
      const telemetry = createMockTelemetryService();
      const strategy = buildStrategy(
        {},
        buildAiDefaults(),
        {},
        buildProviderCatalog(),
        telemetry,
      );

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        provider: LlmProvider.MOCK,
      });

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(telemetry.recordTokenUsage).not.toHaveBeenCalled();
      expect(result.data?.metadata).toMatchObject({
        tokensReasoning: 0,
        totalTokens: 0,
        estimatedCostUSD: 0,
      });
    });
  });
});
