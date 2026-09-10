// Replica exacta de `NodeCatalogResponseDto` del backend
// (`@modules/nodes/dto/node-catalog-response.dto.ts`). Cualquier cambio alli
// debe reflejarse aqui.

import type { NodeType } from '@/types/pipeline';

/** Familia funcional de un tipo de nodo; replica `enum_categoria`. */
export enum NodeCategory {
  TRIGGER = 'TRIGGER',
  PROCESAMIENTO = 'PROCESAMIENTO',
  CONTROL = 'CONTROL',
  DESTINO = 'DESTINO',
}

/** Etiquetas de las agrupaciones del selector. */
export const NODE_CATEGORY_LABELS: Record<NodeCategory, string> = {
  [NodeCategory.TRIGGER]: 'Disparadores',
  [NodeCategory.PROCESAMIENTO]: 'Procesamiento',
  [NodeCategory.CONTROL]: 'Control',
  [NodeCategory.DESTINO]: 'Destinos',
};

/**
 * Entrada del catalogo servida por `GET /api/nodos`.
 *
 * `code` es un `string` y NO un `NodeType`: el catalogo tiene nueve filas y el
 * enum solo declara siete. Tiparlo como `NodeType` obligaria a mentir sobre
 * `TRIGGER_CRON` y `DESTINO_ACENS`, que estan en la tabla precisamente por no
 * ser expresables todavia. `implemented` es la marca que separa unos de otros, y
 * `isImplementedNodeType` el estrechamiento seguro.
 */
export interface NodeCatalogEntry {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly category: NodeCategory;
  readonly description: string | null;
  readonly uiSchema: Record<string, unknown>;
  readonly implemented: boolean;
}

/**
 * Estrecha el `code` de una entrada a `NodeType` cuando el backend la marca como
 * ejecutable.
 *
 * Se apoya en `implemented` y no en un `includes` sobre el enum a proposito: la
 * autoridad sobre que tipos tienen estrategia es el backend, y duplicar aqui esa
 * decision crearia una segunda fuente de verdad que se desincronizaria en cuanto
 * se implemente la octava estrategia.
 */
export const isImplementedNodeType = (
  entry: NodeCatalogEntry,
): entry is NodeCatalogEntry & { readonly code: NodeType } => entry.implemented;
