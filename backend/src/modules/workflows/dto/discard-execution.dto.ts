import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

import { TrimmedString } from '@common/decorators/trimmed-string.decorator';

/** Longitud maxima del motivo que acompana al descarte. */
export const MAX_DISCARD_REASON_LENGTH = 500;

/**
 * Cuerpo opcional de `DELETE /api/executions/:id/discard`.
 *
 * El motivo no condiciona el descarte: solo queda escrito en el evento
 * `FLUJO_DESCARTADO` de `audit_eventos`, para que el auditor sepa POR QUE se
 * cerro el flujo y no solo quien lo hizo.
 */
export class DiscardExecutionDto {
  @ApiPropertyOptional({
    description:
      'Motivo del descarte, en texto plano. Queda registrado en la auditoria',
    maxLength: MAX_DISCARD_REASON_LENGTH,
    example: 'El correo de origen era una prueba interna.',
  })
  @IsOptional()
  @TrimmedString()
  @IsString({ message: 'reason debe ser una cadena.' })
  @MaxLength(MAX_DISCARD_REASON_LENGTH, {
    message: `reason no puede superar ${MAX_DISCARD_REASON_LENGTH} caracteres.`,
  })
  readonly reason?: string;
}
