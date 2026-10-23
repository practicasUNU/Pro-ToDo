import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import { AiDefaultsConfig } from '@core/config/ai-defaults.config';
import { LlmProviderCatalogService } from '@modules/nodes/services/llm-provider-catalog.service';
import {
  LlmProvider,
  LlmProviderException,
} from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import { LlmProviderFactory } from '@modules/nodes/strategies/llm-provider.factory';
import { DEFAULT_GEMINI_MODEL } from '@modules/nodes/strategies/providers/gemini-llm.provider';
import {
  buildOptimizerSystemPrompt,
  buildOptimizerUserPrompt,
  extractPlaceholders,
} from '@modules/prompts/prompt-meta.template';
import { TelemetryOperationOrigin } from '@modules/telemetry/enums/telemetry-origin.enum';
import { TelemetryService } from '@modules/telemetry/telemetry.service';
import { UserRole } from '@modules/users/enums/user-role.enum';

import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';
import type {
  LlmResponsePayload,
  LlmTokenUsage,
} from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import type {
  OptimizePromptDto,
  OptimizePromptResponseDto,
} from '@modules/prompts/dto/optimize-prompt.dto';
import type { TokenUsageMetrics } from '@modules/telemetry/dto/record-telemetry.dto';

/** No hay proveedor real con credencial para atender la peticion. */
export const ERR_PROMPT_OPTIMIZER_UNAVAILABLE =
  'ERR_PROMPT_OPTIMIZER_UNAVAILABLE';
/** El proveedor fallo o respondio algo que no cumple el contrato. */
export const ERR_PROMPT_OPTIMIZER_FAILED = 'ERR_PROMPT_OPTIMIZER_FAILED';
/** El proveedor respondio, pero sin prompt optimizado. */
export const ERR_PROMPT_OPTIMIZER_EMPTY = 'ERR_PROMPT_OPTIMIZER_EMPTY';

/**
 * Espera de la inferencia. Mas larga que la de un nodo de texto (15 s): un
 * prompt de varias paginas se reescribe entero, y al otro lado hay una persona
 * que ha pulsado un boton y prefiere esperar a reintentar (y pagar dos veces).
 */
export const OPTIMIZER_TIMEOUT_MS = 60_000;

/** Un solo reintento rapido, y solo de red: cada reintento con respuesta se factura. */
const OPTIMIZER_MAX_RETRIES = 1;

/** Techo de la respuesta: el prompt reescrito mas las recomendaciones. */
const OPTIMIZER_MAX_TOKENS = 8_192;

/** Poca creatividad: se busca precision, no variedad. */
const OPTIMIZER_TEMPERATURE = 0.3;

/** Proveedor y modelo con los que se atendera la peticion. */
interface ResolvedTarget {
  readonly provider: LlmProvider;
  readonly model: string;
}

/**
 * Asistente "Mejorar Prompt con IA": reescribe un borrador de prompt segun
 * reglas de Prompt Engineering para el formato de salida pedido.
 *
 * TODA inferencia pasa por `TelemetryService.recordAssistUsage` con
 * `origen_operacion = 'PROMPT_OPTIMIZATION'` y el usuario que la pidio,
 * tambien las que fallan despues de que el proveedor respondiera: se facturan
 * igual.
 */
@Injectable()
export class PromptOptimizerService {
  private readonly logger = new Logger(PromptOptimizerService.name);

  constructor(
    private readonly providerFactory: LlmProviderFactory,
    private readonly catalog: LlmProviderCatalogService,
    private readonly aiDefaults: AiDefaultsConfig,
    private readonly telemetryService: TelemetryService,
  ) {}

  public async optimize(
    dto: OptimizePromptDto,
    user: AuthenticatedUser,
  ): Promise<OptimizePromptResponseDto> {
    const target = this.resolveTarget(dto.model, user.role);
    const client = this.providerFactory.getClient(target.provider);

    let payload: LlmResponsePayload;

    try {
      payload = await client.generateCompletion(
        buildOptimizerUserPrompt(dto.draftPrompt),
        buildOptimizerSystemPrompt(dto.targetFormat),
        {
          model: target.model,
          timeoutMs: OPTIMIZER_TIMEOUT_MS,
          maxRetries: OPTIMIZER_MAX_RETRIES,
          temperature: OPTIMIZER_TEMPERATURE,
          maxTokens: OPTIMIZER_MAX_TOKENS,
          mode: 'text',
        },
      );
    } catch (error) {
      // Un fallo DESPUES de la respuesta (contrato roto, truncado) se factura:
      // se registra antes de traducir el error.
      if (error instanceof LlmProviderException && error.usage !== undefined) {
        await this.recordUsage(target, error.usage, user.id);
      }

      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Optimizacion de prompt fallida con ${target.provider}/${target.model}: ${reason}`,
      );

      throw new BadGatewayException({
        code: ERR_PROMPT_OPTIMIZER_FAILED,
        message: `El proveedor de IA no pudo optimizar el prompt: ${reason}`,
      });
    }

    const metrics = await this.recordUsage(
      target,
      {
        modelUsed: payload.metadata.modelUsed,
        tokensPrompt: payload.metadata.tokensPrompt,
        tokensCompletion: payload.metadata.tokensCompletion,
        tokensReasoning: payload.metadata.tokensReasoning ?? 0,
        usageReported: payload.metadata.usageReported ?? true,
      },
      user.id,
    );

    const optimizedPrompt = payload.summary.trim();

    if (optimizedPrompt.length === 0) {
      throw new BadGatewayException({
        code: ERR_PROMPT_OPTIMIZER_EMPTY,
        message:
          'El proveedor de IA respondio sin prompt optimizado. Vuelve a intentarlo o reformula el borrador.',
      });
    }

    return {
      optimizedPrompt,
      recommendations: this.buildRecommendations(
        payload,
        dto.draftPrompt,
        optimizedPrompt,
      ),
      telemetry: {
        tokensPrompt: metrics.promptTokens,
        tokensCompletion: metrics.completionTokens,
        tokensReasoning: metrics.reasoningTokens,
        estimatedCostUSD: metrics.estimatedCostUsd,
        isEstimated: metrics.isEstimated,
        provider: target.provider,
        model: payload.metadata.modelUsed || target.model,
      },
    };
  }

  /**
   * Proveedor y modelo de la peticion.
   *
   * Con `model`, sale del catalogo curado (un modelo fuera de el es un 400, y
   * uno reservado a ADMIN pedido por un EDITOR, un 403, igual que al guardar
   * un flujo). Sin el, el par de texto del entorno y, en su defecto, Gemini.
   *
   * El simulador queda FUERA siempre: ignora el system prompt y devolveria un
   * texto sin relacion con el borrador, presentado como una optimizacion.
   */
  private resolveTarget(
    requestedModel: string | undefined,
    role: UserRole,
  ): ResolvedTarget {
    const models = this.catalog.getAvailableModels();

    if (requestedModel !== undefined) {
      const descriptor = models.find((entry) => entry.model === requestedModel);

      if (descriptor === undefined || descriptor.isTestOnly) {
        throw new BadRequestException(
          `El modelo "${requestedModel}" no esta en el catalogo de modelos optimizadores.`,
        );
      }

      if (
        descriptor.minRoleRequired === UserRole.ADMIN &&
        role !== UserRole.ADMIN
      ) {
        throw new ForbiddenException(
          `El modelo "${requestedModel}" esta reservado al rol ADMIN.`,
        );
      }

      return this.assertUsable({
        provider: descriptor.provider,
        model: descriptor.model,
      });
    }

    const defaults = this.aiDefaults.getTextDefaults();
    const envProvider = Object.values(LlmProvider).find(
      (provider) => provider === defaults.provider,
    );
    const candidates: ResolvedTarget[] = [
      ...(envProvider !== undefined && envProvider !== LlmProvider.MOCK
        ? [
            {
              provider: envProvider,
              model:
                defaults.model ??
                models.find(
                  (entry) =>
                    entry.provider === envProvider && !entry.isTestOnly,
                )?.model ??
                DEFAULT_GEMINI_MODEL,
            },
          ]
        : []),
      { provider: LlmProvider.GEMINI, model: DEFAULT_GEMINI_MODEL },
    ];

    const usable = candidates.find((candidate) =>
      this.catalog.isProviderUsable(candidate.provider),
    );

    return this.assertUsable(usable ?? candidates[candidates.length - 1]);
  }

  private assertUsable(target: ResolvedTarget): ResolvedTarget {
    if (
      target.provider === LlmProvider.MOCK ||
      !this.catalog.isProviderUsable(target.provider)
    ) {
      throw new ServiceUnavailableException({
        code: ERR_PROMPT_OPTIMIZER_UNAVAILABLE,
        message: `El asistente de prompts necesita un proveedor de IA real con credencial y "${target.provider}" no esta disponible en este servidor.`,
      });
    }

    return target;
  }

  /**
   * Registra el consumo. Si la persistencia falla, NO se tumba la respuesta:
   * la inferencia ya esta pagada, y devolver un 500 empujaria a reintentar y
   * pagarla dos veces. El fallo se deja en el log como error y las metricas se
   * calculan igual para el cliente.
   */
  private async recordUsage(
    target: ResolvedTarget,
    usage: LlmTokenUsage,
    userId: string,
  ): Promise<TokenUsageMetrics> {
    const dto = {
      userId,
      origin: TelemetryOperationOrigin.PROMPT_OPTIMIZATION,
      aiProvider: target.provider,
      aiModel: usage.modelUsed || target.model,
      promptTokens: usage.tokensPrompt,
      completionTokens: usage.tokensCompletion,
      reasoningTokens: usage.tokensReasoning,
      usageReported: usage.usageReported,
    } as const;

    try {
      return await this.telemetryService.recordAssistUsage(dto);
    } catch (error) {
      this.logger.error(
        `No se pudo registrar el consumo de la optimizacion de prompt (usuario ${userId}, ${dto.aiProvider}/${dto.aiModel}, ${dto.promptTokens}+${dto.completionTokens}+${dto.reasoningTokens} tokens): ${(error as Error).message}`,
      );

      return this.telemetryService.computeUsage(dto);
    }
  }

  /**
   * Recomendaciones del modelo mas un aviso propio si la propuesta perdio
   * marcadores `{{ns.campo}}` del borrador: aplicarla tal cual dejaria el
   * prompt sin el dato que el flujo interpolaba ahi.
   */
  private buildRecommendations(
    payload: LlmResponsePayload,
    draftPrompt: string,
    optimizedPrompt: string,
  ): string[] {
    const recommendations = payload.body_paragraphs
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph.length > 0);

    const kept = new Set(extractPlaceholders(optimizedPrompt));
    const lost = extractPlaceholders(draftPrompt).filter(
      (placeholder) => !kept.has(placeholder),
    );

    return lost.length > 0
      ? [
          `Atención: la propuesta no conserva ${lost.join(', ')}. Revísala antes de aplicarla o el flujo dejará de interpolar esos datos.`,
          ...recommendations,
        ]
      : recommendations;
  }
}
