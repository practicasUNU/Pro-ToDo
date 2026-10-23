import { ApiProperty } from '@nestjs/swagger';

/**
 * Traza de una ejecucion para el visor de logs (`GET /api/logs/execution/:id`).
 *
 * `rawLog` son las entradas de ESA ejecucion en los `.log` del servidor, una
 * por linea (JSON), sin `payload` y con las rutas del stack recortadas: ver
 * `sanitizeLogEntry`.
 */
export class ExecutionLogResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly executionId: string;

  @ApiProperty({
    description: 'Instante de la entrada principal (el ultimo fallo), ISO',
    nullable: true,
    type: String,
  })
  readonly timestamp: string | null;

  @ApiProperty({
    description:
      'Severidad del fallo (LEVE, GRAVE, URGENTE). `null` si la ejecucion no registro ninguno',
    nullable: true,
    type: String,
  })
  readonly level: string | null;

  @ApiProperty({
    description:
      'Stack trace del ultimo fallo, con rutas relativas al proyecto',
    nullable: true,
    type: String,
  })
  readonly stackTrace: string | null;

  @ApiProperty({
    description:
      'Entradas de la ejecucion en los ficheros de traza, una por linea. Vacio si ya se rotaron',
  })
  readonly rawLog: string;

  @ApiProperty({
    description: 'Verdadero si se alcanzo el tope de entradas o de tamano',
  })
  readonly truncated: boolean;
}
