import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { LlmProvider } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import { SortByField, SortOrderField } from '@common/utils/sort-whitelist.util';

import type {
  SortOrder,
  SortWhitelist,
} from '@common/utils/sort-whitelist.util';

/** Dias que cubre el informe cuando el cliente no indica `from`. */
export const DEFAULT_RANGE_DAYS = 30;

/** Filas por pagina del historial cuando el cliente no pide un tamano. */
export const DEFAULT_HISTORY_LIMIT = 25;

/** Techo del tamano de pagina, mismo criterio que `GET /api/executions`. */
export const MAX_HISTORY_LIMIT = 100;

/**
 * Lista blanca de orden del historial: clave de la API -> ruta del
 * QueryBuilder (`t` = telemetria, `f` = flujo unido). Las claves coinciden con
 * el `name` de las columnas de la tabla del frontend.
 */
export const TELEMETRY_HISTORY_SORT_COLUMNS = {
  createdAt: 't.createdAt',
  flow: 'f.name',
  nodeId: 't.nodeId',
  aiProvider: 't.aiProvider',
  aiModel: 't.aiModel',
  promptTokens: 't.promptTokens',
  completionTokens: 't.completionTokens',
  reasoningTokens: 't.reasoningTokens',
  totalTokens: 't.totalTokens',
  estimatedCostUsd: 't.estimatedCostUsd',
  status: 't.status',
  user: 'u.email',
} as const satisfies SortWhitelist;

export type TelemetryHistorySortKey =
  keyof typeof TELEMETRY_HISTORY_SORT_COLUMNS;

/**
 * Lista blanca de orden del desglose por modelo. Los valores son los ALIAS de
 * las columnas agregadas, entre comillas porque PostgreSQL pliega a minusculas
 * los identificadores sin comillas.
 */
export const TELEMETRY_BREAKDOWN_SORT_COLUMNS = {
  invocations: '"invocations"',
  promptTokens: '"promptTokens"',
  completionTokens: '"completionTokens"',
  reasoningTokens: '"reasoningTokens"',
  totalTokens: '"totalTokens"',
  costUsd: '"costUsd"',
} as const satisfies SortWhitelist;

export type TelemetryBreakdownSortKey =
  keyof typeof TELEMETRY_BREAKDOWN_SORT_COLUMNS;

/**
 * Filtros comunes a los agregados y a las exportaciones de telemetria.
 *
 * `from` / `to` aceptan fecha (`2026-10-01`) o instante ISO. Una fecha sin hora
 * en `to` se interpreta como el dia COMPLETO: es lo que entiende quien elige
 * "hasta el 22" en un selector de fechas. Ver `resolveTelemetryRange`.
 */
export class TelemetryQueryDto {
  @ApiPropertyOptional({
    description: `Inicio del rango (incluido). Por defecto, ${DEFAULT_RANGE_DAYS} dias antes de \`to\``,
    example: '2026-10-01',
  })
  @IsOptional()
  @IsISO8601({}, { message: 'from debe ser una fecha ISO 8601.' })
  readonly from?: string;

  @ApiPropertyOptional({
    description: 'Fin del rango. Una fecha sin hora incluye el dia completo',
    example: '2026-10-22',
  })
  @IsOptional()
  @IsISO8601({}, { message: 'to debe ser una fecha ISO 8601.' })
  readonly to?: string;

  @ApiPropertyOptional({
    description: 'Acota los datos a un flujo',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID('4', { message: 'flowId debe ser un UUID valido.' })
  readonly flowId?: string;

  @ApiPropertyOptional({
    enum: LlmProvider,
    description: 'Acota el consumo a un proveedor de IA',
  })
  @IsOptional()
  @IsEnum(LlmProvider, {
    message: `aiProvider debe ser uno de: ${Object.values(LlmProvider).join(', ')}.`,
  })
  readonly aiProvider?: LlmProvider;

  @ApiPropertyOptional({
    description: 'Acota el consumo a un modelo exacto',
    example: 'gemini-3.6-flash',
  })
  @IsOptional()
  @IsString({ message: 'aiModel debe ser texto.' })
  @MaxLength(100, { message: 'aiModel no puede superar 100 caracteres.' })
  readonly aiModel?: string;

  @ApiPropertyOptional({
    description: 'Acota el consumo a un nodo del pipeline (`nodeId`)',
  })
  @IsOptional()
  @IsString({ message: 'nodeId debe ser texto.' })
  @MaxLength(50, { message: 'nodeId no puede superar 50 caracteres.' })
  readonly nodeId?: string;

  /** Orden del desglose por modelo; por defecto, del mas caro al mas barato. */
  @SortByField(Object.keys(TELEMETRY_BREAKDOWN_SORT_COLUMNS))
  readonly breakdownSortBy?: TelemetryBreakdownSortKey;

  @SortOrderField()
  readonly breakdownSortOrder?: SortOrder;
}

/**
 * Filtros de las exportaciones: los comunes mas el orden del historial, para
 * que el CSV y el PDF salgan en el mismo orden que la tabla en pantalla.
 */
export class TelemetryExportQueryDto extends TelemetryQueryDto {
  @SortByField(Object.keys(TELEMETRY_HISTORY_SORT_COLUMNS))
  readonly sortBy?: TelemetryHistorySortKey;

  @SortOrderField()
  readonly sortOrder?: SortOrder;
}

/** Filtros del historial paginado: los de exportacion mas la pagina. */
export class TelemetryHistoryQueryDto extends TelemetryExportQueryDto {
  @ApiPropertyOptional({
    description: 'Filas por pagina',
    default: DEFAULT_HISTORY_LIMIT,
    minimum: 1,
    maximum: MAX_HISTORY_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit debe ser un numero entero.' })
  @Min(1, { message: 'limit debe ser al menos 1.' })
  @Max(MAX_HISTORY_LIMIT, {
    message: `limit no puede superar ${MAX_HISTORY_LIMIT}.`,
  })
  readonly limit?: number;

  @ApiPropertyOptional({ description: 'Filas a saltar', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'offset debe ser un numero entero.' })
  @Min(0, { message: 'offset no puede ser negativo.' })
  readonly offset?: number;
}
