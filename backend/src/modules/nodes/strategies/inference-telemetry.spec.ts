import {
  ERR_LLM_PROVIDER_TRUNCATED,
  LlmProvider,
  LlmProviderException,
} from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import {
  recordFailedCallUsage,
  recordResponseUsage,
  toUsageMetadata,
} from '@modules/nodes/strategies/inference-telemetry';
import { AiCallStatus } from '@modules/telemetry/enums/ai-call-status.enum';
import { TelemetryOperationOrigin } from '@modules/telemetry/enums/telemetry-origin.enum';
import { ERR_TELEMETRY_PERSIST_FAILED } from '@modules/telemetry/telemetry.service';
import { createMockStatePayloadContext } from '@test/factories/state-payload-context.factory';
import { createMockTelemetryService } from '@test/factories/telemetry-service.factory';

import type { LlmResponsePayload } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import type { TelemetryService } from '@modules/telemetry/telemetry.service';
import type { TelemetryServiceMock } from '@test/factories/telemetry-service.factory';

const EXECUTION_ID = 'exec-11111111-1111-4111-8111-111111111111';
const NODE_ID = 'nodo_ia';
const INITIATOR_ID = '3a8f0c1d-2b4e-4f6a-9c7d-1e2f3a4b5c6d';
const CONFIGURED_MODEL = 'gemini-3.6-flash';

const buildMetadata = (
  overrides: Partial<LlmResponsePayload['metadata']> = {},
): LlmResponsePayload['metadata'] => ({
  tokensPrompt: 1_000,
  tokensCompletion: 500,
  tokensReasoning: 200,
  usageReported: true,
  modelUsed: 'gemini-3.6-flash',
  isMock: false,
  ...overrides,
});

const buildContext = () =>
  createMockStatePayloadContext({
    executionId: EXECUTION_ID,
    currentStep: NODE_ID,
    initiatorUserId: INITIATOR_ID,
  });

const asService = (mock: TelemetryServiceMock): TelemetryService =>
  mock as unknown as TelemetryService;

describe('inference-telemetry', () => {
  describe('recordResponseUsage', () => {
    it('1.1 deberia devolver metricas a 0 y NO insertar con el simulador', async () => {
      // 1. Arrange 📐
      const telemetry = createMockTelemetryService();

      // 2. Act ⚙️
      const outcome = await recordResponseUsage(
        asService(telemetry),
        buildContext(),
        LlmProvider.MOCK,
        buildMetadata({ isMock: true }),
      );

      // 3. Assert 🎯: el simulador no cuesta nada y ensuciaria los agregados.
      expect(telemetry.recordTokenUsage).not.toHaveBeenCalled();
      expect('metrics' in outcome && toUsageMetadata(outcome.metrics)).toEqual({
        tokensPrompt: 0,
        tokensCompletion: 0,
        tokensReasoning: 0,
        totalTokens: 0,
        estimatedCostUSD: 0,
      });
    });

    it('1.1b deberia imputar al usuario una prueba del banco, sin ejecucion', async () => {
      // 1. Arrange 📐: el id efimero del banco no existe en `ejecuciones_flujo`
      //    y el CHECK de la 049 rechazaria la fila como "ejecucion".
      const telemetry = createMockTelemetryService();
      const context = createMockStatePayloadContext({
        executionId: 'sandbox-1',
        currentStep: 'nodo_banco',
        sandboxScope: { userId: 'usuario-1' },
      });

      // 2. Act ⚙️
      await recordResponseUsage(
        asService(telemetry),
        context,
        LlmProvider.GEMINI,
        buildMetadata(),
      );

      // 3. Assert 🎯
      expect(telemetry.recordTokenUsage).not.toHaveBeenCalled();
      expect(telemetry.recordAssistUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: TelemetryOperationOrigin.NODE_SANDBOX,
          userId: 'usuario-1',
          promptTokens: 1_000,
        }),
      );
    });

    it('1.2 deberia registrar con la ejecucion y el nodo del contexto', async () => {
      // 1. Arrange 📐
      const telemetry = createMockTelemetryService();

      // 2. Act ⚙️
      const outcome = await recordResponseUsage(
        asService(telemetry),
        buildContext(),
        LlmProvider.GEMINI,
        buildMetadata(),
      );

      // 3. Assert 🎯
      expect(telemetry.recordTokenUsage).toHaveBeenCalledWith({
        executionId: EXECUTION_ID,
        nodeId: NODE_ID,
        userId: INITIATOR_ID,
        aiProvider: LlmProvider.GEMINI,
        aiModel: 'gemini-3.6-flash',
        promptTokens: 1_000,
        completionTokens: 500,
        reasoningTokens: 200,
        usageReported: true,
        status: AiCallStatus.SUCCESS,
        errorMessage: null,
      });
      expect('metrics' in outcome).toBe(true);
    });

    it('1.3 deberia tratar un metadata sin contadores nuevos como uso informado sin razonamiento', async () => {
      // 1. Arrange 📐: proveedores y literales anteriores a la Fase 1.
      const telemetry = createMockTelemetryService();
      const legacy: LlmResponsePayload['metadata'] = {
        tokensPrompt: 1_000,
        tokensCompletion: 500,
        modelUsed: 'gemini-3.6-flash',
        isMock: false,
      };

      // 2. Act ⚙️
      await recordResponseUsage(
        asService(telemetry),
        buildContext(),
        LlmProvider.GEMINI,
        legacy,
      );

      // 3. Assert 🎯
      expect(telemetry.recordTokenUsage).toHaveBeenCalledWith(
        expect.objectContaining({ reasoningTokens: 0, usageReported: true }),
      );
    });

    it('1.4 deberia devolver GRAVE ERR_TELEMETRY_PERSIST_FAILED si la BD falla', async () => {
      // 1. Arrange 📐
      const telemetry = createMockTelemetryService();
      telemetry.recordTokenUsage.mockRejectedValue(
        new Error('connection terminated unexpectedly'),
      );

      // 2. Act ⚙️
      const outcome = await recordResponseUsage(
        asService(telemetry),
        buildContext(),
        LlmProvider.GEMINI,
        buildMetadata(),
      );

      // 3. Assert 🎯: `exhausted` evita que el motor reintente solo y vuelva a
      //    cobrar una inferencia que ya se pago.
      expect('failure' in outcome && outcome.failure).toMatchObject({
        level: 'GRAVE',
        code: ERR_TELEMETRY_PERSIST_FAILED,
        metadata: { exhausted: true },
      });
      expect('failure' in outcome ? outcome.failure.description : '').toContain(
        'connection terminated unexpectedly',
      );
    });
  });

  describe('recordFailedCallUsage', () => {
    it('2.1 deberia registrar el consumo que viaja en el error del proveedor', async () => {
      // 1. Arrange 📐
      const telemetry = createMockTelemetryService();
      const error = new LlmProviderException(
        'corte',
        ERR_LLM_PROVIDER_TRUNCATED,
      );
      error.usage = {
        modelUsed: 'gemini-3.6-flash',
        tokensPrompt: 10,
        tokensCompletion: 4_096,
        tokensReasoning: 960,
        usageReported: true,
      };

      // 2. Act ⚙️
      const failure = await recordFailedCallUsage(
        asService(telemetry),
        buildContext(),
        LlmProvider.GEMINI,
        error,
        CONFIGURED_MODEL,
      );

      // 3. Assert 🎯
      expect(failure).toBeNull();
      expect(telemetry.recordTokenUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          completionTokens: 4_096,
          reasoningTokens: 960,
          status: AiCallStatus.FAILED,
          errorMessage: 'corte',
        }),
      );
    });

    it('2.2 deberia registrar FAILED con ceros y el modelo configurado si el fallo fue de transporte', async () => {
      // 1. Arrange 📐: sin respuesta no hay consumo, pero la llamada fallo y
      //    la tasa de exito por modelo tiene que verla.
      const telemetry = createMockTelemetryService();

      // 2. Act ⚙️
      const failure = await recordFailedCallUsage(
        asService(telemetry),
        buildContext(),
        LlmProvider.GEMINI,
        new Error('ECONNRESET'),
        CONFIGURED_MODEL,
      );

      // 3. Assert 🎯
      expect(failure).toBeNull();
      expect(telemetry.recordTokenUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          aiModel: CONFIGURED_MODEL,
          promptTokens: 0,
          completionTokens: 0,
          reasoningTokens: 0,
          usageReported: false,
          userId: INITIATOR_ID,
          status: AiCallStatus.FAILED,
          errorMessage: 'ECONNRESET',
        }),
      );
    });

    it('2.2b no deberia detener el nodo si falla el registro de un fallo sin consumo', async () => {
      // 1. Arrange 📐: no hay gasto sin trazar, solo se pierde la estadistica.
      const telemetry = createMockTelemetryService();
      telemetry.recordTokenUsage.mockRejectedValue(new Error('BD caida'));

      // 2. Act ⚙️
      const failure = await recordFailedCallUsage(
        asService(telemetry),
        buildContext(),
        LlmProvider.GEMINI,
        new Error('timeout'),
        CONFIGURED_MODEL,
      );

      // 3. Assert 🎯
      expect(failure).toBeNull();
    });

    it('2.2c no deberia registrar los fallos del simulador', async () => {
      // 1. Arrange 📐
      const telemetry = createMockTelemetryService();

      // 2. Act ⚙️
      await recordFailedCallUsage(
        asService(telemetry),
        buildContext(),
        LlmProvider.MOCK,
        new Error('simulado'),
        'mock',
      );

      // 3. Assert 🎯
      expect(telemetry.recordTokenUsage).not.toHaveBeenCalled();
    });

    it('2.3 deberia devolver el GRAVE si no puede registrar el consumo del error', async () => {
      // 1. Arrange 📐
      const telemetry = createMockTelemetryService();
      telemetry.recordTokenUsage.mockRejectedValue(new Error('BD caida'));
      const error = new LlmProviderException(
        'corte',
        ERR_LLM_PROVIDER_TRUNCATED,
      );
      error.usage = {
        modelUsed: 'gemini-3.6-flash',
        tokensPrompt: 10,
        tokensCompletion: 20,
        tokensReasoning: 0,
        usageReported: true,
      };

      // 2. Act ⚙️
      const failure = await recordFailedCallUsage(
        asService(telemetry),
        buildContext(),
        LlmProvider.GEMINI,
        error,
        CONFIGURED_MODEL,
      );

      // 3. Assert 🎯
      expect(failure).toMatchObject({
        level: 'GRAVE',
        code: ERR_TELEMETRY_PERSIST_FAILED,
      });
    });
  });
});
