import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Fallo del nodo, SIN `stackTrace`: la traza no sale nunca del servidor. */
export class NodeSandboxErrorDto {
  @ApiProperty({ enum: ['LEVE', 'GRAVE', 'URGENTE'] })
  readonly level!: 'LEVE' | 'GRAVE' | 'URGENTE';

  @ApiProperty({ example: 'ERR_HTTP_GENERIC_SERVER' })
  readonly code!: string;

  @ApiProperty()
  readonly message!: string;

  @ApiPropertyOptional()
  readonly description?: string;

  @ApiPropertyOptional({ type: [String] })
  readonly missingFields?: string[];
}

/** Resultado de ejecutar un nodo aislado en el banco de pruebas. */
export class NodeSandboxResultDto {
  @ApiProperty()
  readonly success!: boolean;

  @ApiPropertyOptional({
    description: 'Lo que el nodo escribiria en su namespace.',
  })
  readonly data?: Record<string, unknown>;

  @ApiPropertyOptional({ type: NodeSandboxErrorDto })
  readonly error?: NodeSandboxErrorDto;

  @ApiProperty({ example: 812 })
  readonly durationMs!: number;
}
