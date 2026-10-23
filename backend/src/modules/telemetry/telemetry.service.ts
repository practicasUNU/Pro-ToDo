import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, Repository } from 'typeorm';

import {
  ANY_MODEL,
  PrecioModeloIa,
} from '@modules/telemetry/entities/precio-modelo-ia.entity';
import { TelemetriaTokensIa } from '@modules/telemetry/entities/telemetria-tokens-ia.entity';
import { TelemetryOperationOrigin } from '@modules/telemetry/enums/telemetry-origin.enum';

import type {
  RecordAssistUsageDto,
  RecordTelemetryDto,
  TokenUsageMetrics,
} from '@modules/telemetry/dto/record-telemetry.dto';

/**
 * Codigo con el que un nodo de IA se detiene cuando no pudo dejar constancia
 * de su consumo. Es GRAVE y pausa el flujo: continuar sin trazabilidad del
 * gasto es justo lo que esta tabla existe para impedir.
 */
export const ERR_TELEMETRY_PERSIST_FAILED = 'ERR_TELEMETRY_PERSIST_FAILED';

const TOKENS_PER_PRICING_UNIT = 1_000_000;

/** Seis decimales: la escala de `costo_estimado_usd`. */
const roundUsd = (value: number): number =>
  Math.round(value * TOKENS_PER_PRICING_UNIT) / TOKENS_PER_PRICING_UNIT;

/**
 * Metricas de una inferencia que no costo nada (simulador). Las estrategias
 * las publican igual en su namespace para que la forma de `metadata` no
 * dependa del proveedor.
 */
export const buildZeroUsageMetrics = (): TokenUsageMetrics => ({
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  promptRateUsd: 0,
  completionRateUsd: 0,
  reasoningRateUsd: 0,
  estimatedCostUsd: 0,
  isEstimated: false,
});

/**
 * Calcula el coste de cada inferencia de IA y lo persiste en
 * `telemetria_tokens_ia`.
 *
 * Los errores NO se capturan aqui: la estrategia que llama decide, y su
 * decision es pausar el flujo con `ERR_TELEMETRY_PERSIST_FAILED`.
 */
@Injectable()
export class TelemetryService {
  constructor(
    @InjectRepository(TelemetriaTokensIa)
    private readonly telemetryRepository: Repository<TelemetriaTokensIa>,
    @InjectRepository(PrecioModeloIa)
    private readonly pricingRepository: Repository<PrecioModeloIa>,
  ) {}

  /**
   * Calcula contadores y coste con la tarifa vigente, sin escribir nada. Solo
   * usa proveedor, modelo y contadores, asi que sirve igual para el consumo de
   * una ejecucion y para el del asistente de prompts.
   *
   * Orden de resolucion de la tarifa: la del modelo exacto; si no la hay, la
   * generica del proveedor (`ANY_MODEL`), marcada como estimada; si tampoco,
   * coste 0, tambien estimado. Nunca falla por falta de tarifa: un modelo
   * nuevo sin precio dado de alta no debe pausar flujos en produccion.
   */
  public async computeUsage(
    dto: Omit<RecordTelemetryDto, 'executionId' | 'nodeId'>,
  ): Promise<TokenUsageMetrics> {
    const pricing = await this.resolvePricing(dto.aiProvider, dto.aiModel);

    const promptRateUsd = pricing?.promptRateUsdPerMTok ?? 0;
    const completionRateUsd = pricing?.completionRateUsdPerMTok ?? 0;
    const reasoningRateUsd = pricing?.reasoningRateUsdPerMTok ?? 0;

    const estimatedCostUsd = roundUsd(
      (dto.promptTokens * promptRateUsd +
        dto.completionTokens * completionRateUsd +
        dto.reasoningTokens * reasoningRateUsd) /
        TOKENS_PER_PRICING_UNIT,
    );

    return {
      promptTokens: dto.promptTokens,
      completionTokens: dto.completionTokens,
      reasoningTokens: dto.reasoningTokens,
      totalTokens:
        dto.promptTokens + dto.completionTokens + dto.reasoningTokens,
      promptRateUsd,
      completionRateUsd,
      reasoningRateUsd,
      estimatedCostUsd,
      isEstimated:
        !dto.usageReported || pricing === null || pricing.aiModel === ANY_MODEL,
    };
  }

  /**
   * Calcula el consumo y lo inserta en `telemetria_tokens_ia`. Devuelve las
   * metricas para que la estrategia las publique en su namespace.
   *
   * Una sola sentencia `INSERT ... VALUES ((SELECT id_flujo ...))`: el
   * `flujo_id` sale de `ejecuciones_flujo` en la misma operacion, de modo que no
   * hay ventana entre leer la ejecucion y escribir la fila. Si la ejecucion no
   * existe, el subselect da NULL y el `NOT NULL` de la columna lo rechaza.
   */
  public async recordTokenUsage(
    dto: RecordTelemetryDto,
  ): Promise<TokenUsageMetrics> {
    const metrics = await this.computeUsage(dto);

    await this.telemetryRepository
      .createQueryBuilder()
      .insert()
      .into(TelemetriaTokensIa)
      .values({
        operationOrigin: TelemetryOperationOrigin.FLOW_EXECUTION,
        executionId: dto.executionId,
        flowId: () =>
          '(SELECT id_flujo FROM ejecuciones_flujo WHERE id_ejecucion = :executionId)',
        nodeId: dto.nodeId,
        aiProvider: dto.aiProvider,
        aiModel: dto.aiModel,
        promptTokens: metrics.promptTokens,
        completionTokens: metrics.completionTokens,
        reasoningTokens: metrics.reasoningTokens,
        totalTokens: metrics.totalTokens,
        promptRateUsd: metrics.promptRateUsd,
        completionRateUsd: metrics.completionRateUsd,
        reasoningRateUsd: metrics.reasoningRateUsd,
        estimatedCostUsd: metrics.estimatedCostUsd,
        isEstimated: metrics.isEstimated,
      })
      .setParameter('executionId', dto.executionId)
      .execute();

    return metrics;
  }

  /**
   * Calcula y registra el consumo de una inferencia hecha FUERA de una
   * ejecucion (hoy, el asistente "Mejorar Prompt con IA"), asociada al usuario
   * que la pidio. Sin ejecucion no hay flujo ni nodo: las tres columnas quedan
   * a NULL, como permite el CHECK de la migracion 049 para este origen.
   *
   * Igual que `recordTokenUsage`, no captura errores: decide quien llama.
   */
  public async recordAssistUsage(
    dto: RecordAssistUsageDto,
  ): Promise<TokenUsageMetrics> {
    const metrics = await this.computeUsage(dto);

    await this.telemetryRepository
      .createQueryBuilder()
      .insert()
      .into(TelemetriaTokensIa)
      .values({
        operationOrigin: dto.origin,
        userId: dto.userId,
        executionId: null,
        flowId: null,
        nodeId: null,
        aiProvider: dto.aiProvider,
        aiModel: dto.aiModel,
        promptTokens: metrics.promptTokens,
        completionTokens: metrics.completionTokens,
        reasoningTokens: metrics.reasoningTokens,
        totalTokens: metrics.totalTokens,
        promptRateUsd: metrics.promptRateUsd,
        completionRateUsd: metrics.completionRateUsd,
        reasoningRateUsd: metrics.reasoningRateUsd,
        estimatedCostUsd: metrics.estimatedCostUsd,
        isEstimated: metrics.isEstimated,
      })
      .execute();

    return metrics;
  }

  /** Tarifa vigente mas reciente: la del modelo exacto antes que la generica. */
  private async resolvePricing(
    aiProvider: string,
    aiModel: string,
  ): Promise<PrecioModeloIa | null> {
    const candidates = await this.pricingRepository.find({
      where: {
        aiProvider,
        aiModel: In([aiModel, ANY_MODEL]),
        active: true,
        validFrom: LessThanOrEqual(new Date()),
      },
      order: { validFrom: 'DESC' },
    });

    return (
      candidates.find((row) => row.aiModel === aiModel) ??
      candidates.find((row) => row.aiModel === ANY_MODEL) ??
      null
    );
  }
}
