import { describe, expect, it, jest } from '@jest/globals';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { LlmProvider } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import { LlmProviderFactory } from '@modules/nodes/strategies/llm-provider.factory';
import { MockLlmProvider } from '@modules/nodes/strategies/providers/mock-llm.provider';
import {
  ERR_OCR_CONFIG,
  ERR_OCR_EMPTY_TRANSCRIPTION,
  ERR_OCR_NO_ATTACHMENTS,
  ERR_OCR_PROVIDER_FAILURE,
  OcrProcessorStrategy,
} from '@modules/nodes/strategies/ocr-processor.strategy';

import { createMockStatePayloadContext } from '../../../../test/factories/state-payload-context.factory';

import type { AiDefaultsConfig } from '@core/config/ai-defaults.config';
import type { AnthropicLlmProvider } from '@modules/nodes/strategies/providers/anthropic-llm.provider';
import type { GeminiLlmProvider } from '@modules/nodes/strategies/providers/gemini-llm.provider';
import type { LlmProviderCatalogService } from '@modules/nodes/services/llm-provider-catalog.service';
import type { LlmResponsePayload } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';

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

/** Defaults del entorno sin declarar: se cae a las constantes del DTO. */
const buildAiDefaults = (): AiDefaultsConfig =>
  ({
    getOcrDefaults: jest.fn().mockReturnValue({ provider: null, model: null }),
    getTextDefaults: jest.fn().mockReturnValue({ provider: null, model: null }),
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
): OcrProcessorStrategy => {
  const mockProvider = new MockLlmProvider();
  const strategy = new OcrProcessorStrategy(
    mockProvider,
    buildProviderFactory(mockProvider, gemini, anthropic),
    aiDefaults,
    providerCatalog,
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

    it('1.2 deberia publicar clean_body, para que el motor libere los binarios', () => {
      // 1. Arrange 📐: `clean_body` esta en `EXTRACTED_TEXT_KEYS` del motor.
      //    Llamarlo de otra forma habria obligado a ampliar ese vocabulario en
      //    `@core`, que es justo lo que ese diseno evita.
      const strategy = buildStrategy();

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(strategy.outputFields.map((field) => field.name)).toEqual([
        'clean_body',
        'character_count',
        'ocr_status',
        'metadata',
      ]);
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
          modelUsed: 'gemini-1.5-flash',
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
      expect(result.error?.code).toBe(ERR_OCR_PROVIDER_FAILURE);
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
          modelUsed: 'gemini-1.5-flash',
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
            modelUsed: 'gemini-1.5-flash',
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
        { temperature?: number; maxTokens?: number } | undefined;

      expect(options?.temperature).toBe(0.1);
      expect(options?.maxTokens).toBe(4_096);
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
      //    `gemini-1.5-flash` a Anthropic daria un 404 que parece un fallo de
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

      // 3. Assert 🎯: sigue yendo a Gemini con su modelo, no a Anthropic.
      expect(anthropicCompletion).not.toHaveBeenCalled();
      expect(
        (geminiCompletion.mock.calls[0]?.[2] as { model?: string } | undefined)
          ?.model,
      ).toBe('gemini-1.5-flash');
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
});
