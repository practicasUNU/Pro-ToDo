// Helper puro de presentacion (frontend-architecture.md §2.1): ordena filas ya
// cargadas, sin estado ni I/O.

/** Extrae de una fila el valor por el que se ordena. */
export type SortValueResolver<T> = (row: T) => unknown;

/**
 * ALCANCE, y conviene no perderlo de vista: esto ordena LA PAGINA CARGADA.
 *
 * Las tablas de Informes, Inicio y Auditoria paginan en el servidor, de modo
 * que en memoria solo estan las filas visibles. Ordenar aqui reordena esas
 * filas y ninguna mas: no es un ranking del conjunto, y la cabecera no deberia
 * leerse como tal. La alternativa —mandar el orden al backend— exige lista
 * blanca de columnas, porque TypeORM concatena en crudo el primer argumento de
 * `.orderBy()`.
 */

/**
 * Compara dos valores de celda para el orden ascendente.
 *
 * Reglas, en este orden:
 *   1. Los vacios (`null`, `undefined`, cadena vacia) van SIEMPRE al final, se
 *      ordene como se ordene. Un hueco no es "menor que" nada: es la ausencia
 *      de dato, y verlo encabezando la tabla al ordenar por coste sugiere un
 *      cero que no existe.
 *   2. Numeros por resta.
 *   3. Fechas ISO y texto con `localeCompare` en español, que ordena acentos y
 *      eñes como espera quien lee (una comparacion por punto de codigo pone
 *      "Ñ" detras de "Z"). El formato ISO ordena igual como texto que como
 *      fecha, asi que no hace falta construir `Date`.
 */
/**
 * Representacion comparable de una celda.
 *
 * Solo las primitivas tienen un orden que signifique algo; cualquier otra cosa
 * se manda al final en vez de fingir una comparacion.
 */
const toText = (value: unknown): string =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean' ||
  typeof value === 'bigint'
    ? String(value)
    : '';

const compareValues = (left: unknown, right: unknown): number => {
  const leftEmpty = left === null || left === undefined || left === '';
  const rightEmpty = right === null || right === undefined || right === '';

  if (leftEmpty || rightEmpty) {
    if (leftEmpty && rightEmpty) return 0;

    // Positivo = va despues. Se devuelve sin mirar la direccion porque quien
    // llama invierte el resto del orden, no este.
    return leftEmpty ? 1 : -1;
  }

  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }

  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return Number(left) - Number(right);
  }

  // Se formatean con `toText` y no con `String(...)` a secas: una celda puede
  // traer cualquier cosa del backend, y un objeto se convertiria en
  // "[object Object]", de modo que todos empatarian entre si en silencio.
  return toText(left).localeCompare(toText(right), 'es', {
    numeric: true,
    sensitivity: 'base',
  });
};

/**
 * Copia ordenada de las filas.
 *
 * Devuelve SIEMPRE un array nuevo, incluso sin criterio: ordenar en el sitio
 * mutaria la coleccion del store y rompería la inmutabilidad del estado
 * (`frontend-architecture.md` §2.1), ademas de disparar sus observadores.
 *
 * Los huecos se quedan al final tambien en orden descendente, porque la
 * inversion se aplica solo a las comparaciones entre valores reales.
 *
 * @param rows Filas de la pagina actual.
 * @param sortBy Nombre de la columna, o `null` para conservar el orden del servidor.
 * @param descending Invierte el orden entre valores presentes.
 * @param resolvers Como leer el valor de las columnas cuyo `field` no es una
 *        clave directa de la fila.
 */
export const sortRows = <T extends Record<string, unknown>>(
  rows: readonly T[],
  sortBy: string | null,
  descending: boolean,
  resolvers: Readonly<Record<string, SortValueResolver<T>>> = {},
): T[] => {
  if (sortBy === null || sortBy === '') {
    return [...rows];
  }

  const resolve: SortValueResolver<T> =
    resolvers[sortBy] ?? ((row: T) => row[sortBy]);

  return [...rows].sort((leftRow, rightRow) => {
    const left = resolve(leftRow);
    const right = resolve(rightRow);

    const leftEmpty = left === null || left === undefined || left === '';
    const rightEmpty = right === null || right === undefined || right === '';

    // Los huecos no participan de la inversion: van al final en las dos
    // direcciones, que es lo que espera quien busca "los mas caros" y no
    // quiere que le encabecen la tabla las filas sin coste.
    if (leftEmpty || rightEmpty) {
      return compareValues(left, right);
    }

    const order = compareValues(left, right);

    return descending ? -order : order;
  });
};
