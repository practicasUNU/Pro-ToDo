import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';

/**
 * Direcciones de orden admitidas. Mayusculas porque es lo que TypeORM espera
 * en `.orderBy()`; el DTO normaliza `asc`/`desc` antes de validar.
 */
export const SORT_ORDERS = ['ASC', 'DESC'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

/**
 * Lista blanca de orden: CLAVE publica de la API -> expresion fija del lado
 * servidor (ruta `alias.propiedad` del QueryBuilder o propiedad de la entidad).
 *
 * QUE PROBLEMA RESUELVE. TypeORM concatena en crudo el primer argumento de
 * `.orderBy()`: no hay parametro enlazado posible para un identificador. Un
 * `sortBy` del cliente que llegase hasta ahi seria una inyeccion SQL servida.
 * Con este mapa el texto del cliente SOLO se usa como clave de busqueda; lo
 * que viaja al SQL es siempre un literal escrito en el codigo fuente.
 */
export type SortWhitelist<K extends string = string> = Readonly<
  Record<K, string>
>;

/** Orden ya resuelto, listo para `.orderBy(column, order)`. */
export interface ResolvedSort {
  readonly column: string;
  readonly order: SortOrder;
}

/**
 * Traduce `sortBy`/`sortOrder` a un orden seguro.
 *
 * Segunda linea de defensa: el DTO ya rechaza con 400 cualquier clave ajena
 * (`@SortByField`). Aun asi, si una clave desconocida llegase hasta aqui —un
 * servicio invocado sin pasar por el `ValidationPipe`, una prueba—, se cae al
 * orden por defecto en lugar de interpolarla.
 *
 * `Object.hasOwn` y no `in`: `sortBy=constructor` o `sortBy=__proto__` existen
 * en el PROTOTIPO de cualquier objeto literal y colarian una funcion como
 * nombre de columna.
 */
export const resolveSort = <K extends string>(
  whitelist: SortWhitelist<K>,
  sortBy: string | undefined,
  sortOrder: SortOrder | undefined,
  fallback: { readonly key: K; readonly order: SortOrder },
): ResolvedSort => {
  const order: SortOrder =
    sortOrder !== undefined && SORT_ORDERS.includes(sortOrder)
      ? sortOrder
      : fallback.order;

  if (sortBy === undefined || !Object.hasOwn(whitelist, sortBy)) {
    return { column: whitelist[fallback.key], order: fallback.order };
  }

  return { column: whitelist[sortBy as K], order };
};

/**
 * `sortBy` validado contra las claves de la lista blanca.
 *
 * `IsIn` rechaza tambien un array (`sortBy[]=x`) y cualquier tipo que no sea
 * una de esas cadenas exactas, sin recortes ni normalizaciones: un orden no es
 * texto libre.
 */
export const SortByField = (keys: readonly string[]): PropertyDecorator =>
  applyDecorators(
    ApiPropertyOptional({
      enum: keys,
      description: 'Columna de orden (lista blanca)',
    }),
    IsOptional(),
    IsIn(keys, { message: `sortBy debe ser uno de: ${keys.join(', ')}.` }),
  );

/** `sortOrder` en `ASC`/`DESC`; admite minusculas y las normaliza. */
export const SortOrderField = (): PropertyDecorator =>
  applyDecorators(
    ApiPropertyOptional({
      enum: SORT_ORDERS,
      description: 'Sentido del orden',
    }),
    IsOptional(),
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.toUpperCase() : value,
    ),
    IsIn(SORT_ORDERS, {
      message: `sortOrder debe ser uno de: ${SORT_ORDERS.join(', ')}.`,
    }),
  );
