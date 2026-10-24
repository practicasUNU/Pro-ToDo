import { ApiProperty } from '@nestjs/swagger';

import { AuditFieldsResponseDto } from '@common/dto/audit-response.dto';
import { toAuditFields } from '@common/utils/audit.util';

import type { PrecioModeloIa } from '@modules/telemetry/entities/precio-modelo-ia.entity';

/** Tarifa de un modelo de IA tal como sale por la API. */
export class PricingResponseDto extends AuditFieldsResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id: string;

  @ApiProperty({ example: 'GEMINI' })
  readonly aiProvider: string;

  @ApiProperty({ example: 'gemini-1.5-pro' })
  readonly aiModel: string;

  @ApiProperty({ example: 1.25 })
  readonly promptRateUsdPerMTok: number;

  @ApiProperty({ example: 5 })
  readonly completionRateUsdPerMTok: number;

  @ApiProperty({ example: 5 })
  readonly reasoningRateUsdPerMTok: number;

  @ApiProperty({ description: 'Instante desde el que rige (ISO 8601)' })
  readonly validFrom: string;

  @ApiProperty({ description: 'Vigente (true) o historica (false)' })
  readonly active: boolean;
}

/** Pagina del listado, con el total que cumple el filtro. */
export class PricingPageResponseDto {
  @ApiProperty({ type: [PricingResponseDto] })
  readonly items: PricingResponseDto[];

  @ApiProperty()
  readonly total: number;

  @ApiProperty()
  readonly limit: number;

  @ApiProperty()
  readonly offset: number;
}

/** Proyecta la entidad (cargada con los autores) a la respuesta. */
export const toPricingResponse = (row: PrecioModeloIa): PricingResponseDto => ({
  id: row.id,
  aiProvider: row.aiProvider,
  aiModel: row.aiModel,
  promptRateUsdPerMTok: row.promptRateUsdPerMTok,
  completionRateUsdPerMTok: row.completionRateUsdPerMTok,
  reasoningRateUsdPerMTok: row.reasoningRateUsdPerMTok,
  validFrom: row.validFrom.toISOString(),
  active: row.active,
  ...toAuditFields(row),
});
