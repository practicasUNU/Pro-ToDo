import { ApiProperty } from '@nestjs/swagger';

import { AiCallStatus } from '@modules/telemetry/enums/ai-call-status.enum';
import { TelemetryOperationOrigin } from '@modules/telemetry/enums/telemetry-origin.enum';

/** Rango efectivo de un informe, ya resuelto (instantes ISO, `to` excluido). */
export class TelemetryRangeDto {
  @ApiProperty({ description: 'Inicio del rango (incluido)' })
  readonly from: string;

  @ApiProperty({ description: 'Fin del rango (excluido)' })
  readonly to: string;
}

/** KPIs globales del rango (`GET /api/telemetry/summary`). */
export class TelemetrySummaryResponseDto {
  @ApiProperty({ type: TelemetryRangeDto })
  readonly range: TelemetryRangeDto;

  @ApiProperty({
    description: 'Suma de tokens de prompt, completacion y razonamiento',
  })
  readonly totalTokens: number;

  @ApiProperty({ description: 'Coste estimado total en USD' })
  readonly totalCostUsd: number;

  @ApiProperty({
    description: 'Inferencias de IA facturadas (filas de telemetria)',
  })
  readonly aiInvocations: number;

  @ApiProperty({
    description: 'Inferencias cuyo coste es aproximado (`es_estimado`)',
  })
  readonly estimatedInvocations: number;

  @ApiProperty({
    description:
      'Ejecuciones concluidas (EXITOSO + FALLIDO + DESCARTADO) que invocaron al menos un modelo de IA',
  })
  readonly executionsTotal: number;

  @ApiProperty({ description: 'Ejecuciones EXITOSO que invocaron IA' })
  readonly executionsSucceeded: number;

  @ApiProperty({
    description:
      'executionsSucceeded / executionsTotal, entre 0 y 1. `null` si no hay ejecuciones concluidas',
    nullable: true,
    type: Number,
  })
  readonly successRate: number | null;
}

/** Consumo agregado de un modelo (`GET /api/telemetry/breakdown-by-model`). */
export class ModelBreakdownResponseDto {
  @ApiProperty({ example: 'GEMINI' })
  readonly aiProvider: string;

  @ApiProperty({ example: 'gemini-3.6-flash' })
  readonly aiModel: string;

  @ApiProperty()
  readonly invocations: number;

  @ApiProperty()
  readonly promptTokens: number;

  @ApiProperty()
  readonly completionTokens: number;

  @ApiProperty()
  readonly reasoningTokens: number;

  @ApiProperty()
  readonly totalTokens: number;

  @ApiProperty({ description: 'Coste estimado en USD' })
  readonly costUsd: number;

  @ApiProperty({ description: 'Llamadas con estado SUCCESS' })
  readonly succeeded: number;

  @ApiProperty({ description: 'Llamadas con estado FAILED' })
  readonly failed: number;

  @ApiProperty({
    description: 'succeeded / invocations, entre 0 y 1. `null` sin llamadas',
    nullable: true,
    type: Number,
  })
  readonly successRate: number | null;
}

/** Una inferencia registrada, con el nombre del flujo resuelto. */
export class TelemetryHistoryItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id: string;

  @ApiProperty({ description: 'Instante de la inferencia (ISO)' })
  readonly createdAt: string;

  @ApiProperty({
    enum: TelemetryOperationOrigin,
    description: 'Que provoco la inferencia (migracion 049)',
  })
  readonly operationOrigin: TelemetryOperationOrigin;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'null fuera de una ejecucion (asistente de prompts)',
  })
  readonly executionId: string | null;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  readonly flowId: string | null;

  @ApiProperty({ nullable: true, type: String })
  readonly flowName: string | null;

  @ApiProperty({ nullable: true, type: String })
  readonly nodeId: string | null;

  @ApiProperty()
  readonly aiProvider: string;

  @ApiProperty()
  readonly aiModel: string;

  @ApiProperty()
  readonly promptTokens: number;

  @ApiProperty()
  readonly completionTokens: number;

  @ApiProperty()
  readonly reasoningTokens: number;

  @ApiProperty()
  readonly totalTokens: number;

  @ApiProperty({ description: 'Tarifa aplicada, USD por millon de tokens' })
  readonly promptRateUsd: number;

  @ApiProperty({ description: 'Tarifa aplicada, USD por millon de tokens' })
  readonly completionRateUsd: number;

  @ApiProperty({ description: 'Tarifa aplicada, USD por millon de tokens' })
  readonly reasoningRateUsd: number;

  @ApiProperty()
  readonly estimatedCostUsd: number;

  @ApiProperty()
  readonly isEstimated: boolean;

  @ApiProperty({ enum: AiCallStatus })
  readonly status: AiCallStatus;

  @ApiProperty({ nullable: true, type: String })
  readonly errorMessage: string | null;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  readonly userId: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Correo del usuario al que se imputa la llamada',
  })
  readonly userEmail: string | null;
}

/** Opcion de filtro de modelo, ligada a su proveedor. */
export class TelemetryModelOptionDto {
  @ApiProperty()
  readonly aiProvider: string;

  @ApiProperty()
  readonly aiModel: string;
}

/** Opcion de filtro de flujo, con su nombre. */
export class TelemetryFlowOptionDto {
  @ApiProperty({ format: 'uuid' })
  readonly id: string;

  @ApiProperty()
  readonly name: string;
}

/** Opcion de filtro de nodo, ligada a su flujo. */
export class TelemetryNodeOptionDto {
  @ApiProperty({ format: 'uuid' })
  readonly flowId: string;

  @ApiProperty()
  readonly nodeId: string;
}

/**
 * Valores que aparecen en la telemetria del rango
 * (`GET /api/telemetry/filter-options`). Alimenta selectores cerrados: el
 * usuario solo puede filtrar por lo que existe (Poka-Yoke).
 */
export class TelemetryFilterOptionsResponseDto {
  @ApiProperty({ type: [String] })
  readonly providers: string[];

  @ApiProperty({ type: [TelemetryModelOptionDto] })
  readonly models: TelemetryModelOptionDto[];

  @ApiProperty({ type: [TelemetryFlowOptionDto] })
  readonly flows: TelemetryFlowOptionDto[];

  @ApiProperty({ type: [TelemetryNodeOptionDto] })
  readonly nodes: TelemetryNodeOptionDto[];
}

/** Pagina del historial (`GET /api/telemetry/history`). */
export class TelemetryHistoryPageResponseDto {
  @ApiProperty({ type: [TelemetryHistoryItemResponseDto] })
  readonly items: TelemetryHistoryItemResponseDto[];

  @ApiProperty()
  readonly total: number;

  @ApiProperty()
  readonly limit: number;

  @ApiProperty()
  readonly offset: number;
}
