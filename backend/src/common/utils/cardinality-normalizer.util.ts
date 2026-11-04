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

/**
 * Modo de cardinalidad declarado por un nodo.
 *
 * - `SINGLE`: 1 a 1 estricto; un solo elemento en la raiz.
 * - `MULTIPLE`: 1 a N estricto; el modelo recibe la regla del lote.
 * - `AUTO`: tolerante; el modelo decide si el material trae uno o varios, y la
 *   cardinalidad efectiva se resuelve DESPUES, al contar lo que devolvio.
 */
export type OutputCardinalityMode = 'SINGLE' | 'MULTIPLE' | 'AUTO';

/** Cardinalidad ya resuelta: la que de verdad tiene una respuesta concreta. */
export type ResolvedCardinality = 'SINGLE' | 'MULTIPLE';

/**
 * Cardinalidad efectiva de una respuesta con `itemCount` elementos.
 *
 * Los modos estrictos mandan sobre el recuento; `AUTO` lo mira: mas de un
 * elemento es un lote y uno solo (o ninguno) es 1 a 1.
 */
export const resolveCardinality = (
  mode: OutputCardinalityMode,
  itemCount: number,
): ResolvedCardinality => {
  if (mode === 'SINGLE') return 'SINGLE';
  if (mode === 'MULTIPLE') return 'MULTIPLE';

  return itemCount > 1 ? 'MULTIPLE' : 'SINGLE';
};

/** Vista normalizada de un payload con cardinalidad: raiz + lista completa. */
export interface NormalizedCardinality {
  /** Cardinalidad efectiva (ver `resolveCardinality`). */
  readonly cardinality: ResolvedCardinality;
  /** Primer elemento, sin la clave del contenedor. */
  readonly root: Record<string, unknown>;
  /**
   * TODOS los elementos, raiz incluida y en orden. Con un solo elemento es
   * `[root]` en cualquier modo, de modo que quien itera nunca distingue 1 a 1
   * de 1 a N.
   */
  readonly items: readonly Record<string, unknown>[];
}

/**
 * Normalizacion tri-estado sobre el contrato ASIMETRICO del cable.
 *
 * El JSON que publican la IA y el escudo sigue siendo asimetrico (raiz = 1.er
 * elemento, `itemsKey` = el resto, vacio con uno solo): asi un elemento nunca se
 * publica dos veces. Esta funcion es la vista SIMETRICA para los consumidores:
 * `items` es la lista completa y, con N = 1 en `MULTIPLE` o `AUTO`, vale
 * `[root]` sin que nadie tenga que fabricar un lote de uno.
 *
 * Con `SINGLE` se ignora cualquier `itemsKey` que hubiera: el nodo pidio un
 * solo elemento y lo que sobre no se publica.
 */
export const normalizeCardinality = (
  payload: Record<string, unknown>,
  mode: OutputCardinalityMode,
  itemsKey = DEFAULT_CONTAINER_KEY,
): NormalizedCardinality => {
  const [root, ...rest] = expandRootAndItems(payload, itemsKey);
  const items = mode === 'SINGLE' ? [root] : [root, ...rest];

  return {
    cardinality: resolveCardinality(mode, items.length),
    root,
    items,
  };
};
