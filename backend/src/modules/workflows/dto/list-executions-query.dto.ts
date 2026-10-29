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

import { ExecutionState } from '@core/fsm/types/fsm.enums';
import { SortByField, SortOrderField } from '@common/utils/sort-whitelist.util';

import type {
  SortOrder,
  SortWhitelist,
} from '@common/utils/sort-whitelist.util';

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
 * Lista blanca de orden: clave de la API -> propiedad de `FsmExecution`.
 *
 * Las claves coinciden con el `name` de las columnas de la tabla del frontend
 * (`startedAt` es la fecha de alta de la fila). El nombre del flujo NO esta:
 * vive en otra tabla y el listado no la une.
 */
export const EXECUTION_SORT_COLUMNS = {
  state: 'currentState',
  startedAt: 'createdAt',
  updatedAt: 'updatedAt',
} as const satisfies SortWhitelist;

export type ExecutionSortKey = keyof typeof EXECUTION_SORT_COLUMNS;

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
    description: 'Inicio del rango de fecha de inicio (incluido)',
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

  @SortByField(Object.keys(EXECUTION_SORT_COLUMNS))
  readonly sortBy?: ExecutionSortKey;

  @SortOrderField()
  readonly sortOrder?: SortOrder;
}
