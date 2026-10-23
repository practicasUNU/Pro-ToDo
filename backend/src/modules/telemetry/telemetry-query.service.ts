import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import { ExecutionState } from '@core/fsm/types/fsm.enums';
import {
  DEFAULT_HISTORY_LIMIT,
  TelemetryHistoryQueryDto,
  TelemetryQueryDto,
} from '@modules/telemetry/dto/telemetry-query.dto';
import { TelemetriaTokensIa } from '@modules/telemetry/entities/telemetria-tokens-ia.entity';
import { resolveTelemetryRange } from '@modules/telemetry/utils/telemetry-range.util';

import type { SelectQueryBuilder } from 'typeorm';
import type {
  ModelBreakdownResponseDto,
  TelemetryHistoryItemResponseDto,
  TelemetryHistoryPageResponseDto,
  TelemetrySummaryResponseDto,
} from '@modules/telemetry/dto/telemetry-report-response.dto';
import type { TelemetryRange } from '@modules/telemetry/utils/telemetry-range.util';

/**
 * Techo de filas de una exportacion.
 *
 * El CSV no pagina: es un volcado para la hoja de calculo. Aun asi un rango de
 * un ano sobre un sondeo por minuto puede rondar el millon de filas, y montarlo
 * entero en memoria tumbaria el proceso. El informe indica cuando se corto.
 */
export const MAX_EXPORT_ROWS = 50_000;

/**
 * Estados que cuentan como ejecucion CONCLUIDA en la tasa de exito.
 *
 * Fuera quedan las vivas (INACTIVO, EN_PROCESO, PAUSADO), que aun no tienen
 * desenlace, y OMITIDO, que es un sondeo sin trabajo: contarlo hundiria o
 * inflaria la tasa segun lo vacio que estuviese el buzon. DESCARTADO si cuenta:
 * es una ejecucion que no llego a buen puerto, aunque la cerrase un operador.
 */
const CONCLUDED_STATES: readonly ExecutionState[] = [
  ExecutionState.EXITOSO,
  ExecutionState.FALLIDO,
  ExecutionState.DESCARTADO,
];

/** Fila cruda de los agregados: PostgreSQL devuelve SUM/COUNT como texto. */
type RawAggregate = Record<string, string | null>;

/** Resultado de una exportacion: las filas y si se cortaron en el techo. */
export interface TelemetryExportRows {
  readonly range: TelemetryRange;
  readonly items: TelemetryHistoryItemResponseDto[];
  readonly truncated: boolean;
}

/**
 * Limites del rango como instantes ISO en UTC. Se envian como texto y no como
 * `Date` porque `pg` serializa un `Date` en la zona LOCAL del proceso; con el
 * `CAST(... AS timestamptz)` de las consultas, el ISO con `Z` no admite dos
 * lecturas.
 */
const toRangeParameters = (
  range: TelemetryRange,
): { from: string; to: string } => ({
  from: range.from.toISOString(),
  to: range.to.toISOString(),
});

/** `SUM`/`COUNT` crudo a numero; un agregado sin filas llega como `null`. */
const toNumber = (value: string | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value);

/**
 * Lecturas agregadas de `telemetria_tokens_ia` para el dashboard y los
 * informes.
 *
 * Separado de `TelemetryService` por el mismo motivo que
 * `FsmExecutionQueryService` lo esta del motor: aquel ESCRIBE en el camino
 * caliente de cada inferencia y no debe crecer con cada informe nuevo; este
 * solo LEE y lo consumen el controlador y las exportaciones.
 */
@Injectable()
export class TelemetryQueryService {
  constructor(
    @InjectRepository(TelemetriaTokensIa)
    private readonly telemetryRepository: Repository<TelemetriaTokensIa>,
    @InjectRepository(FsmExecution)
    private readonly executionRepository: Repository<FsmExecution>,
  ) {}

  /** KPIs globales: tokens, coste, invocaciones y tasa de exito del rango. */
  public async getSummary(
    query: TelemetryQueryDto,
  ): Promise<TelemetrySummaryResponseDto> {
    const range = resolveTelemetryRange(query);

    const usage = await this.filteredTelemetry(query, range)
      .select('COALESCE(SUM(t.tokens_totales), 0)', 'totalTokens')
      .addSelect('COALESCE(SUM(t.costo_estimado_usd), 0)', 'totalCostUsd')
      .addSelect('COUNT(*)', 'aiInvocations')
      .addSelect(
        'COUNT(*) FILTER (WHERE t.es_estimado)',
        'estimatedInvocations',
      )
      .getRawOne<RawAggregate>();

    const executionsQuery = this.executionRepository
      .createQueryBuilder('e')
      .select('COUNT(*)', 'executionsTotal')
      .addSelect(
        'COUNT(*) FILTER (WHERE e.estado = :succeeded)',
        'executionsSucceeded',
      )
      .where('e.estado IN (:...concluded)', { concluded: CONCLUDED_STATES })
      // CAST explicito y no un `Date` a secas: `fecha_inicio` es TIMESTAMP SIN
      // zona, y comparar contra un parametro sin tipar lo convierte a TIMESTAMP
      // descartando su desfase. Con el proceso de Node en otra zona que la de
      // PostgreSQL, el rango se desplazaba horas y dejaba fuera las ejecuciones
      // recientes. Como `timestamptz`, la columna se interpreta en la zona de
      // la sesion, que es la que la escribio con `CURRENT_TIMESTAMP`.
      .andWhere(
        'e.fecha_inicio >= CAST(:from AS timestamptz) AND e.fecha_inicio < CAST(:to AS timestamptz)',
        toRangeParameters(range),
      )
      .setParameter('succeeded', ExecutionState.EXITOSO);

    if (query.flowId !== undefined) {
      executionsQuery.andWhere('e.id_flujo = :flowId', {
        flowId: query.flowId,
      });
    }

    const executions = await executionsQuery.getRawOne<RawAggregate>();

    const executionsTotal = toNumber(executions?.executionsTotal);
    const executionsSucceeded = toNumber(executions?.executionsSucceeded);

    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      totalTokens: toNumber(usage?.totalTokens),
      totalCostUsd: toNumber(usage?.totalCostUsd),
      aiInvocations: toNumber(usage?.aiInvocations),
      estimatedInvocations: toNumber(usage?.estimatedInvocations),
      executionsTotal,
      executionsSucceeded,
      successRate:
        executionsTotal === 0 ? null : executionsSucceeded / executionsTotal,
    };
  }

  /** Consumo agregado por proveedor y modelo, del mas caro al mas barato. */
  public async getBreakdownByModel(
    query: TelemetryQueryDto,
  ): Promise<ModelBreakdownResponseDto[]> {
    const range = resolveTelemetryRange(query);

    const rows = await this.filteredTelemetry(query, range)
      .select('t.proveedor_ia', 'aiProvider')
      .addSelect('t.modelo_ia', 'aiModel')
      .addSelect('COUNT(*)', 'invocations')
      .addSelect('SUM(t.tokens_prompt)', 'promptTokens')
      .addSelect('SUM(t.tokens_completacion)', 'completionTokens')
      .addSelect('SUM(t.tokens_razonamiento)', 'reasoningTokens')
      .addSelect('SUM(t.tokens_totales)', 'totalTokens')
      .addSelect('SUM(t.costo_estimado_usd)', 'costUsd')
      .groupBy('t.proveedor_ia')
      .addGroupBy('t.modelo_ia')
      .orderBy('"costUsd"', 'DESC')
      .addOrderBy('"totalTokens"', 'DESC')
      .getRawMany<RawAggregate>();

    return rows.map((row) => ({
      aiProvider: row.aiProvider ?? '',
      aiModel: row.aiModel ?? '',
      invocations: toNumber(row.invocations),
      promptTokens: toNumber(row.promptTokens),
      completionTokens: toNumber(row.completionTokens),
      reasoningTokens: toNumber(row.reasoningTokens),
      totalTokens: toNumber(row.totalTokens),
      costUsd: toNumber(row.costUsd),
    }));
  }

  /** Inferencias registradas, mas recientes primero, paginadas. */
  public async getHistory(
    query: TelemetryHistoryQueryDto,
  ): Promise<TelemetryHistoryPageResponseDto> {
    const range = resolveTelemetryRange(query);
    const limit = query.limit ?? DEFAULT_HISTORY_LIMIT;
    const offset = query.offset ?? 0;

    const [rows, total] = await this.historyQuery(query, range)
      .take(limit)
      .skip(offset)
      .getManyAndCount();

    return {
      items: rows.map((row) => this.toHistoryItem(row)),
      total,
      limit,
      offset,
    };
  }

  /** Todas las filas del rango para exportar, hasta `MAX_EXPORT_ROWS`. */
  public async getExportRows(
    query: TelemetryQueryDto,
  ): Promise<TelemetryExportRows> {
    const range = resolveTelemetryRange(query);

    // Se pide UNA fila de mas para saber si el techo corto el informe sin
    // lanzar un COUNT aparte sobre el mismo rango.
    const rows = await this.historyQuery(query, range)
      .take(MAX_EXPORT_ROWS + 1)
      .getMany();

    return {
      range,
      items: rows
        .slice(0, MAX_EXPORT_ROWS)
        .map((row) => this.toHistoryItem(row)),
      truncated: rows.length > MAX_EXPORT_ROWS,
    };
  }

  /**
   * Consulta base con los filtros comunes. Se escribe con NOMBRES DE COLUMNA y
   * no de propiedad porque los agregados son expresiones SQL crudas: mezclar
   * los dos dialectos en la misma consulta invita a errores silenciosos.
   */
  private filteredTelemetry(
    query: TelemetryQueryDto,
    range: TelemetryRange,
  ): SelectQueryBuilder<TelemetriaTokensIa> {
    const builder = this.telemetryRepository
      .createQueryBuilder('t')
      .where(
        't.creado_en >= CAST(:from AS timestamptz) AND t.creado_en < CAST(:to AS timestamptz)',
        toRangeParameters(range),
      );

    if (query.flowId !== undefined) {
      builder.andWhere('t.flujo_id = :flowId', { flowId: query.flowId });
    }

    if (query.aiProvider !== undefined) {
      builder.andWhere('t.proveedor_ia = :aiProvider', {
        aiProvider: query.aiProvider,
      });
    }

    return builder;
  }

  /**
   * Filas completas con el NOMBRE del flujo. Del flujo solo se seleccionan id y
   * nombre: la entidad completa arrastraria el `configuracion_pipeline` de cada
   * fila, que puede pesar kilobytes, a un listado que no lo usa.
   */
  private historyQuery(
    query: TelemetryQueryDto,
    range: TelemetryRange,
  ): SelectQueryBuilder<TelemetriaTokensIa> {
    return this.filteredTelemetry(query, range)
      .leftJoin('t.flow', 'f')
      .addSelect(['f.id', 'f.name'])
      .orderBy('t.createdAt', 'DESC')
      .addOrderBy('t.id', 'DESC');
  }

  private toHistoryItem(
    row: TelemetriaTokensIa,
  ): TelemetryHistoryItemResponseDto {
    return {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      executionId: row.executionId,
      flowId: row.flowId,
      flowName: row.flow?.name ?? null,
      nodeId: row.nodeId,
      aiProvider: row.aiProvider,
      aiModel: row.aiModel,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      reasoningTokens: row.reasoningTokens,
      totalTokens: row.totalTokens,
      promptRateUsd: row.promptRateUsd,
      completionRateUsd: row.completionRateUsd,
      reasoningRateUsd: row.reasoningRateUsd,
      estimatedCostUsd: row.estimatedCostUsd,
      isEstimated: row.isEstimated,
    };
  }
}
