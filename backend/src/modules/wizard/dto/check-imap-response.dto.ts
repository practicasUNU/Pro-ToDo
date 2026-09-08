import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { NodeErrorSeverity } from '@core/fsm/types/node-strategy.types';

/** Mensaje devuelto cuando la conexion se establece y el buzon existe. */
export const CHECK_IMAP_SUCCESS_MESSAGE = 'Conexión exitosa';

/** Detalle del fallo de una comprobacion, con la severidad del motor FSM. */
export class CheckImapErrorDto {
  @ApiProperty({
    description:
      'Severidad del fallo, con la misma escala que `NodeResult.error.level`',
    example: 'GRAVE',
    enum: ['LEVE', 'GRAVE', 'URGENTE'],
  })
  level: NodeErrorSeverity;

  @ApiProperty({
    description: 'Motivo legible del fallo de conexion',
    example:
      'Fallo la conexion IMAP con imap.unuware.com:993: Invalid credentials',
  })
  message: string;
}

/**
 * Resultado de la comprobacion de conectividad del asistente.
 *
 * NO incluye `stackTrace`, a diferencia de `NodeErrorDetail`: la traza revela
 * rutas del sistema de archivos del servidor y no aporta nada a quien esta
 * rellenando un formulario. Al `.log` fisico sigue yendo completa.
 */
export class CheckImapResponseDto {
  @ApiProperty({
    description: 'true si se pudo autenticar y abrir el buzon indicado',
    example: true,
  })
  success: boolean;

  @ApiPropertyOptional({
    description: 'Confirmacion legible. Presente solo cuando `success` es true',
    example: CHECK_IMAP_SUCCESS_MESSAGE,
  })
  message?: string;

  @ApiPropertyOptional({
    description: 'Detalle del fallo. Presente solo cuando `success` es false',
    type: CheckImapErrorDto,
  })
  error?: CheckImapErrorDto;
}
