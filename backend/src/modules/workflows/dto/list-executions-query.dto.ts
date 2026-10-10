import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

import { ExecutionState } from '@core/fsm/types/fsm.enums';

/** Filas por pagina cuando el cliente no pide un tamano. */
export const DEFAULT_PAGE_LIMIT = 25;

/**
 * Techo duro del tamano de pagina.
 *
 * El listado omite `contexto_acumulado`, asi que una fila pesa poco; el limite
 * existe para que un `limit=100000` no convierta una peticion de lectura en un
 * volcado de la tabla entera.
 */
export const MAX_PAGE_LIMIT = 100;

/**
 * Filtros de `GET /api/executions`.
 *
 * Primer DTO de query del proyecto: los demas controladores reciben el valor
 * crudo y lo interpretan a mano. Aqui no basta, porque `limit` y `offset` van
 * directos al `take`/`skip` de TypeORM: un `limit=abc` daria `NaN` y un
 * `limit=99999` un volcado. Validarlo en la frontera lo convierte en un 400
 * legible en vez de en un sintoma raro tres capas mas abajo.
 *
 * Funciona porque `main.ts` registra el `ValidationPipe` global con
 * `transform: true`: sin esa opcion, `@Type(() => Number)` no se aplicaria y
 * los numeros llegarian como cadenas.
 */
export class ListExecutionsQueryDto {
  @ApiPropertyOptional({
    description: 'Acota el listado a las ejecuciones de un flujo concreto',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID('4', { message: 'flowId debe ser un UUID valido.' })
  readonly flowId?: string;

  @ApiPropertyOptional({
    enum: ExecutionState,
    description:
      'Acota el listado a un estado. PAUSADO es el que alimenta la cola de reintentos de CU-09',
  })
  @IsOptional()
  @IsEnum(ExecutionState, {
    message: `state debe ser uno de: ${Object.values(ExecutionState).join(', ')}.`,
  })
  readonly state?: ExecutionState;

  @ApiPropertyOptional({
    description: 'Filas por pagina',
    default: DEFAULT_PAGE_LIMIT,
    minimum: 1,
    maximum: MAX_PAGE_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit debe ser un numero entero.' })
  @Min(1, { message: 'limit debe ser al menos 1.' })
  @Max(MAX_PAGE_LIMIT, {
    message: `limit no puede superar ${MAX_PAGE_LIMIT}.`,
  })
  readonly limit?: number;

  @ApiPropertyOptional({
    description: 'Filas a saltar desde el inicio del listado',
    default: 0,
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'offset debe ser un numero entero.' })
  @Min(0, { message: 'offset no puede ser negativo.' })
  readonly offset?: number;
}
