import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { TrimmedString } from '@common/decorators/trimmed-string.decorator';
import { SortByField, SortOrderField } from '@common/utils/sort-whitelist.util';

import type {
  SortOrder,
  SortWhitelist,
} from '@common/utils/sort-whitelist.util';

/** Filas por pagina cuando el cliente no pide un tamano. */
export const DEFAULT_PRICING_LIMIT = 25;

/** Techo del tamano de pagina, mismo criterio que el resto de listados. */
export const MAX_PRICING_LIMIT = 100;

/** Techo del buscador: mismo que el filtro de los `q-select` del frontend. */
export const MAX_PRICING_SEARCH_LENGTH = 100;

/**
 * Ventana del filtro de fechas cuando solo llega uno de los extremos. Amplia a
 * proposito: las tarifas cambian pocas veces al ano, y una ventana de 30 dias
 * como la de telemetria esconderia las vigentes mas antiguas.
 */
export const PRICING_RANGE_DAYS = 3650;

/**
 * Lista blanca de orden: clave de la API -> propiedad del QueryBuilder (`p`).
 * Rutas de PROPIEDAD porque el listado une los autores y pagina con
 * `take`/`skip`, y TypeORM solo sabe reescribir ese orden con propiedades.
 */
export const PRICING_SORT_COLUMNS = {
  aiProvider: 'p.aiProvider',
  aiModel: 'p.aiModel',
  promptRateUsdPerMTok: 'p.promptRateUsdPerMTok',
  completionRateUsdPerMTok: 'p.completionRateUsdPerMTok',
  reasoningRateUsdPerMTok: 'p.reasoningRateUsdPerMTok',
  validFrom: 'p.validFrom',
  active: 'p.active',
} as const satisfies SortWhitelist;

export type PricingSortKey = keyof typeof PRICING_SORT_COLUMNS;

/**
 * Booleano de query string. Solo `true`/`false` literales: cualquier otro
 * valor pasa intacto para que `@IsBoolean` lo rechace con su mensaje, en vez
 * de convertir `"si"` en `true` por ser una cadena no vacia.
 */
const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  return value;
};

/** Filtros, pagina y orden de `GET /api/pricing`. */
export class ListPricingQueryDto {
  @ApiPropertyOptional({
    description: 'Busca por proveedor o modelo (sin distinguir mayusculas)',
    maxLength: MAX_PRICING_SEARCH_LENGTH,
  })
  @IsOptional()
  @TrimmedString()
  @IsString({ message: 'search debe ser texto.' })
  @MaxLength(MAX_PRICING_SEARCH_LENGTH, {
    message: `search no puede superar ${MAX_PRICING_SEARCH_LENGTH} caracteres.`,
  })
  readonly search?: string;

  @ApiPropertyOptional({
    description: 'Inicio del rango sobre la fecha de vigencia (incluido)',
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
    description: 'Solo las tarifas vigentes (sin el historico)',
    default: false,
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean({ message: 'activeOnly debe ser true o false.' })
  readonly activeOnly?: boolean;

  @ApiPropertyOptional({
    description: 'Filas por pagina',
    default: DEFAULT_PRICING_LIMIT,
    minimum: 1,
    maximum: MAX_PRICING_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit debe ser un numero entero.' })
  @Min(1, { message: 'limit debe ser al menos 1.' })
  @Max(MAX_PRICING_LIMIT, {
    message: `limit no puede superar ${MAX_PRICING_LIMIT}.`,
  })
  readonly limit?: number;

  @ApiPropertyOptional({ description: 'Filas a saltar', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'offset debe ser un numero entero.' })
  @Min(0, { message: 'offset no puede ser negativo.' })
  readonly offset?: number;

  @SortByField(Object.keys(PRICING_SORT_COLUMNS))
  readonly sortBy?: PricingSortKey;

  @SortOrderField()
  readonly sortOrder?: SortOrder;
}
