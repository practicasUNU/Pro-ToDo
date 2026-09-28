import { describe, expect, it, jest } from '@jest/globals';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { LlmProvider } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
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
import type { GeminiLlmProvider } from '@modules/nodes/strategies/providers/gemini-llm.provider';
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

const buildStrategy = (
  gemini: Partial<GeminiLlmProvider> = {},
  aiDefaults: AiDefaultsConfig = buildAiDefaults(),
): OcrProcessorStrategy => {
  const strategy = new OcrProcessorStrategy(
    new MockLlmProvider(),
    gemini as GeminiLlmProvider,
    aiDefaults,
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
      ]);
    });
  });

  describe('2. Transcripcion con el simulador', () => {
    it('2.1 deberia devolver la transcripcion determinista', async () => {
      // 1. Arrange 📐
      const strategy = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {});

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
      const result = await strategy.execute(buildContext(), {});

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
      const result = await strategy.execute(buildContext(), {});

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
});
