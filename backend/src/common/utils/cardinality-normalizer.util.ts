// Helper puro: sin estado ni E/S.
//
// Cardinalidad 1 a 1 y 1 a N. Un mismo nodo puede recibir un elemento suelto
// ({...}), un arreglo ([{...}]) o un contenedor ({ items: [...] }); estas dos
// funciones lo reducen siempre a un arreglo, de modo que cada estrategia itera
// con un `for` sin preguntar antes que forma trae el payload.

/** Contenedor que se busca cuando no se declara otro. */
const DEFAULT_CONTAINER_KEY = 'items';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Normaliza cualquier payload a una coleccion `T[]`.
 *
 * - `null`, `undefined` o un primitivo: `[]`, porque no describen ningun
 *   elemento.
 * - Un arreglo: el mismo arreglo sin huecos (`null`/`undefined`).
 * - Un objeto con `containerKey` (o `items` si no se indica): el contenido de
 *   esa clave, normalizado con estas mismas reglas.
 * - Cualquier otro objeto: un arreglo unitario (cardinalidad 1 a 1).
 */
export const normalizeItems = <T>(
  payload: unknown,
  containerKey?: string,
): T[] => {
  if (Array.isArray(payload)) {
    return payload.filter(
      (item): item is T => item !== null && item !== undefined,
    );
  }

  if (!isRecord(payload)) {
    return [];
  }

  const key = containerKey ?? DEFAULT_CONTAINER_KEY;

  if (key in payload) {
    const contained = payload[key];

    // El contenedor declarado manda aunque traiga un objeto suelto: es el
    // elemento unico de esa coleccion, no el payload entero.
    if (Array.isArray(contained)) {
      return contained.filter(
        (item): item is T => item !== null && item !== undefined,
      );
    }

    return isRecord(contained) ? [contained as T] : [];
  }

  return [payload as T];
};

/**
 * Despliega el contrato ASIMETRICO de cardinalidad: la raiz es el primer
 * elemento y `root[itemsKey]` los restantes.
 *
 * Devuelve `[raizSinItems, ...items]`. La raiz se entrega SIN la clave del
 * contenedor para que quien itere no vea el lote anidado dentro del primer
 * elemento. El objeto de entrada no se modifica: se construye uno nuevo con el
 * operador spread.
 */
export const expandRootAndItems = <T extends Record<string, unknown>>(
  root: T,
  itemsKey = DEFAULT_CONTAINER_KEY,
): Record<string, unknown>[] => {
  const { [itemsKey]: rest, ...first } = root;

  return [first, ...normalizeItems<Record<string, unknown>>(rest)];
};
