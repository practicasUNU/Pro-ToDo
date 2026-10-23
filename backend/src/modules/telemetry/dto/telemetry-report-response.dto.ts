import { ApiProperty } from '@nestjs/swagger';

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
    description: 'Ejecuciones concluidas: EXITOSO + FALLIDO + DESCARTADO',
  })
  readonly executionsTotal: number;

  @ApiProperty({ description: 'Ejecuciones EXITOSO' })
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
