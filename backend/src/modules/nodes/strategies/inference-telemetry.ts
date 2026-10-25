import {
  ERR_TELEMETRY_PERSIST_FAILED,
  buildZeroUsageMetrics,
} from '@modules/telemetry/telemetry.service';
import { LlmProviderException } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import { TelemetryOperationOrigin } from '@modules/telemetry/enums/telemetry-origin.enum';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type { NodeErrorDetail } from '@core/fsm/types/node-strategy.types';
import type {
  LlmProvider,
  LlmResponsePayload,
} from '@modules/nodes/strategies/interfaces/llm-provider.interface';
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
  });
};

/**
 * Consumo de una llamada que fallo DESPUES de que el proveedor respondiera.
 *
 * Devuelve `null` cuando no hay nada que registrar (fallo de transporte, sin
 * `usage`) o cuando se registro bien; el nodo sigue entonces con su propio
 * tratamiento del error. Solo devuelve un fallo si el registro no se pudo hacer.
 */
export const recordFailedCallUsage = async (
  telemetry: TelemetryService,
  context: StatePayloadContext,
  provider: LlmProvider,
  error: unknown,
): Promise<NodeErrorDetail | null> => {
  if (!(error instanceof LlmProviderException) || error.usage === undefined) {
    return null;
  }

  const outcome = await persist(telemetry, context, provider, error.usage);

  return 'failure' in outcome ? outcome.failure : null;
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
      });

      return { metrics: sandboxMetrics };
    }

    const metrics = await telemetry.recordTokenUsage({
      executionId: context.getExecutionId(),
      // El cursor ES el `nodeId` en curso: el motor lo mueve antes de ejecutar.
      nodeId: context.getCursor(),
      aiProvider: provider,
      aiModel: usage.modelUsed,
      promptTokens: usage.tokensPrompt,
      completionTokens: usage.tokensCompletion,
      reasoningTokens: usage.tokensReasoning,
      usageReported: usage.usageReported,
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
