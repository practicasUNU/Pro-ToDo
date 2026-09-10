import { api } from '@boot/axios';

import type { NodeCatalogEntry } from '@/types/node-catalog';

// Unica capa que conoce la ruta de `NodeCatalogController`. Retorna la data ya
// desestructurada; las excepciones HTTP se propagan hacia el store y de ahi al
// componente, que es quien decide el mensaje al usuario.

/**
 * Catalogo de tipos de nodo que el motor sabe ejecutar.
 *
 * El backend lo devuelve ya ordenado por categoria y nombre, e incluye los tipos
 * SIN estrategia marcados con `implemented: false` para que el selector los
 * muestre deshabilitados en vez de ocultarlos.
 */
export const fetchNodeCatalog = async (): Promise<NodeCatalogEntry[]> => {
  const { data } = await api.get<NodeCatalogEntry[]>('/nodos');
  return data;
};
