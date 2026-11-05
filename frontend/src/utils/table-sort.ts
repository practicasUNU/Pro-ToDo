// Helper puro de presentacion (frontend-architecture.md §2.1): traduce el orden
// de un `q-table` a los parametros de la API, sin estado ni I/O.

import type { SortQuery, TableSort } from '@/types/sort';

/**
 * El orden se resuelve en el SERVIDOR: las tablas de Informes, Inicio,
 * Auditoria y Precios paginan alli, y ordenar en el cliente solo reordenaba la
 * pagina visible —la cabecera decia "por coste" y mostraba las 25 filas
 * cargadas, no las 25 mas caras—. El backend valida `sortBy` contra una lista
 * blanca y nunca interpola el texto recibido en `.orderBy()`.
 */

/**
 * Normaliza el `sortBy` que entrega QTable a una clave admitida.
 *
 * QTable devuelve el `name` de la columna pulsada como `string`; cualquier
 * cosa fuera de la lista blanca —una columna no ordenable, un valor manipulado—
 * se convierte en "sin criterio" en lugar de viajar y volver como 400.
 */
export const toSortKey = <K extends string>(
  keys: readonly K[],
  value: string | null | undefined,
): K | null => (value != null && (keys as readonly string[]).includes(value) ? (value as K) : null);

/** Construye el `TableSort` a partir de lo que pide QTable en `@request`. */
export const toTableSort = <K extends string>(
  keys: readonly K[],
  sortBy: string | null | undefined,
  descending: boolean,
): TableSort<K> => {
  const key = toSortKey(keys, sortBy);

  // Sin criterio, `descending` no significa nada: se normaliza para que dos
  // estados "sin orden" sean iguales y no provoquen recargas espurias.
  return { sortBy: key, descending: key === null ? false : descending };
};

/** Parametros de query del orden. Sin criterio no viaja nada. */
export const toSortQuery = <K extends string>(sort: TableSort<K>): SortQuery<K> =>
  sort.sortBy === null
    ? {}
    : { sortBy: sort.sortBy, sortOrder: sort.descending ? 'DESC' : 'ASC' };
