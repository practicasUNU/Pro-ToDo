import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

import { LlmProvider } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import {
  SortByField,
  SortOrderField,
} from '@common/utils/sort-whitelist.util';

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
  totalTokens: 't.totalTokens',
  estimatedCostUsd: 't.estimatedCostUsd',
} as const satisfies SortWhitelist;

export type TelemetryHistorySortKey =
  keyof typeof TELEMETRY_HISTORY_SORT_COLUMNS;

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
}

/** Filtros del historial paginado: los comunes mas la pagina. */
export class TelemetryHistoryQueryDto extends TelemetryQueryDto {
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

  @SortByField(Object.keys(TELEMETRY_HISTORY_SORT_COLUMNS))
  readonly sortBy?: TelemetryHistorySortKey;

  @SortOrderField()
  readonly sortOrder?: SortOrder;
}
