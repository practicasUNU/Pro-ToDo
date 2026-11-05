import {
  ERR_TELEMETRY_PERSIST_FAILED,
  buildZeroUsageMetrics,
} from '@modules/telemetry/telemetry.service';
import {
  LlmProvider,
  LlmProviderException,
} from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import { AiCallStatus } from '@modules/telemetry/enums/ai-call-status.enum';
import { TelemetryOperationOrigin } from '@modules/telemetry/enums/telemetry-origin.enum';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type { NodeErrorDetail } from '@core/fsm/types/node-strategy.types';
import type { LlmResponsePayload } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import type { TokenUsageMetrics } from '@modules/telemetry/dto/record-telemetry.dto';
import type { TelemetryService } from '@modules/telemetry/telemetry.service';

/**
 * Registro de consumo compartido por los dos nodos que hablan con un modelo
 * (`PROCESADOR_IA` y `PROCESADOR_OCR`), para que la regla sea UNA:
 *
 * 1. Si el proveedor respondio —bien o mal—, la inferencia se facturo y se
 *    registra ANTES de decidir nada mas.
 * 2. Si el registro falla, el nodo se detiene con GRAVE
 *    `ERR_TELEMETRY_PERSIST_FAILED`: seguir sin trazabilidad del gasto es lo
 *    que la telemetria existe para impedir.
 * 3. El simulador no se registra: no cuesta nada y ensuciaria los agregados.
 * 4. Toda llamada fallida deja fila `FAILED` (migracion 060), con su `usage` si
 *    el proveedor lo informo y con ceros si no: sin ella la tasa de exito por
 *    modelo solo veria los fallos que se facturan.
 */

/** Resultado del registro: las metricas, o el fallo que debe devolver el nodo. */
export type InferenceTelemetryOutcome =
  | { readonly metrics: TokenUsageMetrics }
  | { readonly failure: NodeErrorDetail };

/** Lo que el nodo publica en `metadata` de su namespace. */
export interface InferenceUsageMetadata {
  readonly tokensPrompt: number;
  readonly tokensCompletion: number;
  readonly tokensReasoning: number;
  readonly totalTokens: number;
  readonly estimatedCostUSD: number;
}

/** Consumo de una respuesta valida del proveedor. */
export const recordResponseUsage = async (
  telemetry: TelemetryService,
  context: StatePayloadContext,
  provider: LlmProvider,
  metadata: LlmResponsePayload['metadata'],
): Promise<InferenceTelemetryOutcome> => {
  if (metadata.isMock) {
    return { metrics: buildZeroUsageMetrics() };
  }

  return persist(telemetry, context, provider, {
    modelUsed: metadata.modelUsed,
    tokensPrompt: metadata.tokensPrompt,
    tokensCompletion: metadata.tokensCompletion,
    tokensReasoning: metadata.tokensReasoning ?? 0,
    usageReported: metadata.usageReported ?? true,
    status: AiCallStatus.SUCCESS,
    errorMessage: null,
  });
};

/**
 * Registra una llamada fallida como `FAILED`.
 *
 * Si el fallo llego DESPUES de que el proveedor respondiera (contrato roto,
 * respuesta truncada), la inferencia se facturo y se registra con su `usage`;
 * si el registro no se puede hacer, devuelve el fallo GRAVE que debe devolver
 * el nodo, igual que en una respuesta buena.
 *
 * Si fue de transporte (timeout, 5xx sin cuerpo) no hay consumo: la fila va con
 * ceros y el modelo configurado, solo para la tasa de exito. Ese registro es
 * best-effort y nunca detiene el nodo, que ya tiene su propio error que tratar.
 *
 * @param model Modelo configurado para el intento: el que habria respondido.
 */
export const recordFailedCallUsage = async (
  telemetry: TelemetryService,
  context: StatePayloadContext,
  provider: LlmProvider,
  error: unknown,
  model: string,
): Promise<NodeErrorDetail | null> => {
  if (provider === LlmProvider.MOCK) {
    return null;
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  const usage = error instanceof LlmProviderException ? error.usage : undefined;

  if (usage !== undefined) {
    const outcome = await persist(telemetry, context, provider, {
      ...usage,
      status: AiCallStatus.FAILED,
      errorMessage,
    });

    return 'failure' in outcome ? outcome.failure : null;
  }

  await persist(telemetry, context, provider, {
    modelUsed: model,
    tokensPrompt: 0,
    tokensCompletion: 0,
    tokensReasoning: 0,
    usageReported: false,
    status: AiCallStatus.FAILED,
    errorMessage,
  });

  return null;
};

/** Forma publica de las metricas dentro de `metadata`. */
export const toUsageMetadata = (
  metrics: TokenUsageMetrics,
): InferenceUsageMetadata => ({
  tokensPrompt: metrics.promptTokens,
  tokensCompletion: metrics.completionTokens,
  tokensReasoning: metrics.reasoningTokens,
  totalTokens: metrics.totalTokens,
  estimatedCostUSD: metrics.estimatedCostUsd,
});

const persist = async (
  telemetry: TelemetryService,
  context: StatePayloadContext,
  provider: LlmProvider,
  usage: {
    readonly modelUsed: string;
    readonly tokensPrompt: number;
    readonly tokensCompletion: number;
    readonly tokensReasoning: number;
    readonly usageReported: boolean;
    readonly status: AiCallStatus;
    readonly errorMessage: string | null;
  },
): Promise<InferenceTelemetryOutcome> => {
  try {
    const sandbox = context.getSandboxScope();

    // Banco de pruebas: no hay fila en `ejecuciones_flujo` a la que colgar el
    // consumo, y el CHECK de la migracion 049 rechazaria una fila de
    // "ejecucion" sin ella. Se imputa al usuario con su propio origen (057).
    if (sandbox !== null) {
      const sandboxMetrics = await telemetry.recordAssistUsage({
        origin: TelemetryOperationOrigin.NODE_SANDBOX,
        userId: sandbox.userId,
        aiProvider: provider,
        aiModel: usage.modelUsed,
        promptTokens: usage.tokensPrompt,
        completionTokens: usage.tokensCompletion,
        reasoningTokens: usage.tokensReasoning,
        usageReported: usage.usageReported,
        status: usage.status,
        errorMessage: usage.errorMessage,
      });

      return { metrics: sandboxMetrics };
    }

    const metrics = await telemetry.recordTokenUsage({
      executionId: context.getExecutionId(),
      // El cursor ES el `nodeId` en curso: el motor lo mueve antes de ejecutar.
      nodeId: context.getCursor(),
      userId: context.getInitiatorUserId(),
      aiProvider: provider,
      aiModel: usage.modelUsed,
      promptTokens: usage.tokensPrompt,
      completionTokens: usage.tokensCompletion,
      reasoningTokens: usage.tokensReasoning,
      usageReported: usage.usageReported,
      status: usage.status,
      errorMessage: usage.errorMessage,
    });

    return { metrics };
  } catch (error) {
    const description = error instanceof Error ? error.message : String(error);

    return {
      failure: {
        level: 'GRAVE',
        code: ERR_TELEMETRY_PERSIST_FAILED,
        message:
          'No se pudo registrar el consumo de tokens de la inferencia. Flujo pausado para no continuar sin trazabilidad del gasto.',
        description: `${provider}/${usage.modelUsed}: ${usage.tokensPrompt} tokens de prompt, ${usage.tokensCompletion} de completacion y ${usage.tokensReasoning} de razonamiento sin registrar. Causa raiz: ${description}`,
        // El nodo ya pago la inferencia: reintentarlo automaticamente la
        // volveria a cobrar. Que lo reanude un operador cuando la BD responda.
        metadata: { exhausted: true },
        ...(error instanceof Error && error.stack !== undefined
          ? { stackTrace: error.stack }
          : {}),
      },
    };
  }
};
