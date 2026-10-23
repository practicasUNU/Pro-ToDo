import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

import { AuditTable } from '@modules/audit/audit-tables';
import { AuditActionType } from '@modules/audit/enums/audit-action.enum';

/** Dias que cubre la consulta cuando el cliente no indica `from`. */
export const DEFAULT_AUDIT_RANGE_DAYS = 30;

/** Filas por pagina cuando el cliente no pide un tamano. */
export const DEFAULT_AUDIT_LIMIT = 25;

/** Techo del tamano de pagina, mismo criterio que `GET /api/executions`. */
export const MAX_AUDIT_LIMIT = 100;

/** Formatos de exportacion del informe de auditoria. */
export const AUDIT_REPORT_FORMATS = ['csv', 'pdf'] as const;
export type AuditReportFormat = (typeof AUDIT_REPORT_FORMATS)[number];

/**
 * Filtros comunes a la consulta paginada y a la exportacion.
 *
 * `from` / `to` aceptan fecha (`2026-10-01`) o instante ISO; una fecha sin hora
 * en `to` incluye el dia completo (`resolveDateRange`).
 */
export class AuditEventsFilterDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Usuario que actuo' })
  @IsOptional()
  @IsUUID('4', { message: 'userId debe ser un UUID valido.' })
  readonly userId?: string;

  @ApiPropertyOptional({ enum: AuditTable, description: 'Tabla afectada' })
  @IsOptional()
  @IsEnum(AuditTable, {
    message: `affectedTable debe ser una de: ${Object.values(AuditTable).join(', ')}.`,
  })
  readonly affectedTable?: AuditTable;

  @ApiPropertyOptional({ enum: AuditActionType })
  @IsOptional()
  @IsEnum(AuditActionType, {
    message: `action debe ser una de: ${Object.values(AuditActionType).join(', ')}.`,
  })
  readonly action?: AuditActionType;

  @ApiPropertyOptional({
    description: `Inicio del rango (incluido). Por defecto, ${DEFAULT_AUDIT_RANGE_DAYS} dias antes de \`to\``,
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
}

/** Consulta paginada: los filtros mas la pagina. */
export class ListAuditEventsQueryDto extends AuditEventsFilterDto {
  @ApiPropertyOptional({
    description: 'Filas por pagina',
    default: DEFAULT_AUDIT_LIMIT,
    minimum: 1,
    maximum: MAX_AUDIT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit debe ser un numero entero.' })
  @Min(1, { message: 'limit debe ser al menos 1.' })
  @Max(MAX_AUDIT_LIMIT, {
    message: `limit no puede superar ${MAX_AUDIT_LIMIT}.`,
  })
  readonly limit?: number;

  @ApiPropertyOptional({ description: 'Filas a saltar', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'offset debe ser un numero entero.' })
  @Min(0, { message: 'offset no puede ser negativo.' })
  readonly offset?: number;
}

/** Exportacion: los filtros mas el formato del fichero. */
export class ExportAuditReportQueryDto extends AuditEventsFilterDto {
  @ApiProperty({ enum: AUDIT_REPORT_FORMATS })
  @IsIn(AUDIT_REPORT_FORMATS, {
    message: `format debe ser uno de: ${AUDIT_REPORT_FORMATS.join(', ')}.`,
  })
  readonly format: AuditReportFormat;
}
