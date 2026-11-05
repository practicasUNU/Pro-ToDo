import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import { ExecutionState } from '@core/fsm/types/fsm.enums';
import { resolveSort } from '@common/utils/sort-whitelist.util';
import {
  DEFAULT_HISTORY_LIMIT,
  TELEMETRY_BREAKDOWN_SORT_COLUMNS,
  TELEMETRY_HISTORY_SORT_COLUMNS,
  TelemetryExportQueryDto,
  TelemetryHistoryQueryDto,
  TelemetryQueryDto,
} from '@modules/telemetry/dto/telemetry-query.dto';
import { AiCallStatus } from '@modules/telemetry/enums/ai-call-status.enum';
import { TelemetriaTokensIa } from '@modules/telemetry/entities/telemetria-tokens-ia.entity';
import { resolveTelemetryRange } from '@modules/telemetry/utils/telemetry-range.util';

import type { SelectQueryBuilder } from 'typeorm';
import type {
  ModelBreakdownResponseDto,
  TelemetryFilterOptionsResponseDto,
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

/** Proporcion entre 0 y 1, o `null` si no hay base sobre la que calcularla. */
const toRate = (part: number, total: number): number | null =>
  total === 0 ? null : part / total;

/** Tasa de exito de las ejecuciones que invocaron IA. */
interface AiFlowSuccessRate {
  readonly executionsTotal: number;
  readonly executionsSucceeded: number;
  readonly successRate: number | null;
}

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

    const executions = await this.getAiOnlyFlowSuccessRate(query, range);

    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      totalTokens: toNumber(usage?.totalTokens),
      totalCostUsd: toNumber(usage?.totalCostUsd),
      aiInvocations: toNumber(usage?.aiInvocations),
      estimatedInvocations: toNumber(usage?.estimatedInvocations),
      ...executions,
    };
  }

  /**
   * Tasa de exito de los flujos CON IA: solo cuentan las ejecuciones concluidas
   * que dejaron al menos una fila en `telemetria_tokens_ia`.
   *
   * Antes se contaban todas, y un flujo sin IA que sondea cada minuto hundia o
   * inflaba una metrica que se presenta en el informe de consumo de IA. El
   * `EXISTS` aplica los mismos filtros de proveedor, modelo y nodo que el resto
   * del informe: con "solo Gemini" activo, la tasa es la de los flujos que
   * llamaron a Gemini.
   */
  private async getAiOnlyFlowSuccessRate(
    query: TelemetryQueryDto,
    range: TelemetryRange,
  ): Promise<AiFlowSuccessRate> {
    const telemetryFilters = [
      'ti.ejecucion_id = e.id_ejecucion',
      ...(query.aiProvider !== undefined
        ? ['ti.proveedor_ia = :aiProvider']
        : []),
      ...(query.aiModel !== undefined ? ['ti.modelo_ia = :aiModel'] : []),
      ...(query.nodeId !== undefined ? ['ti.nodo_id = :nodeId'] : []),
    ];

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
      .andWhere(
        `EXISTS (SELECT 1 FROM telemetria_tokens_ia ti WHERE ${telemetryFilters.join(' AND ')})`,
        {
          aiProvider: query.aiProvider,
          aiModel: query.aiModel,
          nodeId: query.nodeId,
        },
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
      executionsTotal,
      executionsSucceeded,
      successRate: toRate(executionsSucceeded, executionsTotal),
    };
  }

  /**
   * Consumo y tasa de exito agregados por proveedor y modelo. Por defecto del
   * mas caro al mas barato; `breakdownSortBy`/`breakdownSortOrder` lo cambian.
   *
   * La tasa por modelo sale de `estado` (migracion 060): cada llamada, buena o
   * fallida, deja su fila, asi que SUCCESS / total es la fiabilidad real del
   * modelo y no solo la de las llamadas que se facturaron.
   */
  public async getBreakdownByModel(
    query: TelemetryQueryDto,
  ): Promise<ModelBreakdownResponseDto[]> {
    const range = resolveTelemetryRange(query);
    const sort = resolveSort(
      TELEMETRY_BREAKDOWN_SORT_COLUMNS,
      query.breakdownSortBy,
      query.breakdownSortOrder,
      { key: 'costUsd', order: 'DESC' },
    );

    const rows = await this.filteredTelemetry(query, range)
      .select('t.proveedor_ia', 'aiProvider')
      .addSelect('t.modelo_ia', 'aiModel')
      .addSelect('COUNT(*)', 'invocations')
      .addSelect('SUM(t.tokens_prompt)', 'promptTokens')
      .addSelect('SUM(t.tokens_completacion)', 'completionTokens')
      .addSelect('SUM(t.tokens_razonamiento)', 'reasoningTokens')
      .addSelect('SUM(t.tokens_totales)', 'totalTokens')
      .addSelect('SUM(t.costo_estimado_usd)', 'costUsd')
      .addSelect('COUNT(*) FILTER (WHERE t.estado = :success)', 'succeeded')
      .addSelect('COUNT(*) FILTER (WHERE t.estado = :failed)', 'failed')
      .setParameter('success', AiCallStatus.SUCCESS)
      .setParameter('failed', AiCallStatus.FAILED)
      .groupBy('t.proveedor_ia')
      .addGroupBy('t.modelo_ia')
      .orderBy(sort.column, sort.order)
      .addOrderBy('"totalTokens"', 'DESC')
      .getRawMany<RawAggregate>();

    return rows.map((row) => this.toBreakdownRow(row));
  }

  /**
   * Proveedores, modelos, flujos y nodos que aparecen en la telemetria del
   * rango, para los selectores cerrados del informe. Solo el rango acota: un
   * filtro activo no debe esconder las opciones a las que se querria cambiar.
   */
  public async getFilterOptions(
    query: TelemetryQueryDto,
  ): Promise<TelemetryFilterOptionsResponseDto> {
    const range = resolveTelemetryRange(query);
    const inRange = (): SelectQueryBuilder<TelemetriaTokensIa> =>
      this.telemetryRepository
        .createQueryBuilder('t')
        .where(
          't.creado_en >= CAST(:from AS timestamptz) AND t.creado_en < CAST(:to AS timestamptz)',
          toRangeParameters(range),
        );

    const [models, flows, nodes] = await Promise.all([
      inRange()
        .select('t.proveedor_ia', 'aiProvider')
        .addSelect('t.modelo_ia', 'aiModel')
        .distinct(true)
        .orderBy('"aiProvider"')
        .addOrderBy('"aiModel"')
        .getRawMany<RawAggregate>(),
      inRange()
        .innerJoin('t.flow', 'f')
        .select('f.id', 'id')
        .addSelect('f.name', 'name')
        .distinct(true)
        .orderBy('"name"')
        .getRawMany<RawAggregate>(),
      inRange()
        .select('t.flujo_id', 'flowId')
        .addSelect('t.nodo_id', 'nodeId')
        .andWhere('t.flujo_id IS NOT NULL AND t.nodo_id IS NOT NULL')
        .distinct(true)
        .orderBy('"nodeId"')
        .getRawMany<RawAggregate>(),
    ]);

    const modelOptions = models.map((row) => ({
      aiProvider: row.aiProvider ?? '',
      aiModel: row.aiModel ?? '',
    }));

    return {
      providers: [...new Set(modelOptions.map((row) => row.aiProvider))],
      models: modelOptions,
      flows: flows.map((row) => ({ id: row.id ?? '', name: row.name ?? '' })),
      nodes: nodes.map((row) => ({
        flowId: row.flowId ?? '',
        nodeId: row.nodeId ?? '',
      })),
    };
  }

  private toBreakdownRow(row: RawAggregate): ModelBreakdownResponseDto {
    const invocations = toNumber(row.invocations);
    const succeeded = toNumber(row.succeeded);

    return {
      aiProvider: row.aiProvider ?? '',
      aiModel: row.aiModel ?? '',
      invocations,
      promptTokens: toNumber(row.promptTokens),
      completionTokens: toNumber(row.completionTokens),
      reasoningTokens: toNumber(row.reasoningTokens),
      totalTokens: toNumber(row.totalTokens),
      costUsd: toNumber(row.costUsd),
      succeeded,
      failed: toNumber(row.failed),
      successRate: toRate(succeeded, invocations),
    };
  }

  /**
   * Inferencias registradas, paginadas. Por defecto las mas recientes
   * primero; `sortBy`/`sortOrder` ordenan el historial entero en el servidor.
   */
  public async getHistory(
    query: TelemetryHistoryQueryDto,
  ): Promise<TelemetryHistoryPageResponseDto> {
    const range = resolveTelemetryRange(query);
    const limit = query.limit ?? DEFAULT_HISTORY_LIMIT;
    const offset = query.offset ?? 0;

    const [rows, total] = await this.sortedHistoryQuery(query, range)
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

  /**
   * Todas las filas del rango para exportar, hasta `MAX_EXPORT_ROWS`, con los
   * mismos filtros y el mismo orden que el historial en pantalla.
   */
  public async getExportRows(
    query: TelemetryExportQueryDto,
  ): Promise<TelemetryExportRows> {
    const range = resolveTelemetryRange(query);

    // Se pide UNA fila de mas para saber si el techo corto el informe sin
    // lanzar un COUNT aparte sobre el mismo rango.
    const rows = await this.sortedHistoryQuery(query, range)
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

    if (query.aiModel !== undefined) {
      builder.andWhere('t.modelo_ia = :aiModel', { aiModel: query.aiModel });
    }

    if (query.nodeId !== undefined) {
      builder.andWhere('t.nodo_id = :nodeId', { nodeId: query.nodeId });
    }

    return builder;
  }

  /**
   * Historial ordenado segun `sortBy`/`sortOrder`. `NULLS LAST` en los dos
   * sentidos: un nodo o flujo ausente (consumo del asistente de prompts) no es
   * "el menor" ni "el mayor", es un hueco, y va al final. El id desempata para
   * que la paginacion sea estable.
   */
  private sortedHistoryQuery(
    query: TelemetryExportQueryDto,
    range: TelemetryRange,
  ): SelectQueryBuilder<TelemetriaTokensIa> {
    const sort = resolveSort(
      TELEMETRY_HISTORY_SORT_COLUMNS,
      query.sortBy,
      query.sortOrder,
      { key: 'createdAt', order: 'DESC' },
    );

    return this.historyQuery(query, range)
      .orderBy(sort.column, sort.order, 'NULLS LAST')
      .addOrderBy('t.id', sort.order);
  }

  /**
   * Filas completas con el NOMBRE del flujo y el CORREO del usuario. De cada
   * relacion solo se seleccionan dos columnas: el flujo completo arrastraria
   * el `configuracion_pipeline` de cada fila, y el usuario su `secreto_otp`.
   */
  private historyQuery(
    query: TelemetryQueryDto,
    range: TelemetryRange,
  ): SelectQueryBuilder<TelemetriaTokensIa> {
    return this.filteredTelemetry(query, range)
      .leftJoin('t.flow', 'f')
      .addSelect(['f.id', 'f.name'])
      .leftJoin('t.user', 'u')
      .addSelect(['u.id', 'u.email'])
      .orderBy('t.createdAt', 'DESC')
      .addOrderBy('t.id', 'DESC');
  }

  private toHistoryItem(
    row: TelemetriaTokensIa,
  ): TelemetryHistoryItemResponseDto {
    return {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      operationOrigin: row.operationOrigin,
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
      status: row.status,
      errorMessage: row.errorMessage,
      userId: row.userId,
      userEmail: row.user?.email ?? null,
    };
  }
}
