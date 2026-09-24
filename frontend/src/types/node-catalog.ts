// Replica exacta de `NodeCatalogResponseDto` del backend
// (`@modules/nodes/dto/node-catalog-response.dto.ts`). Cualquier cambio alli
// debe reflejarse aqui.

import type { NodeType } from '@/types/pipeline';

/**
 * Tipo semantico de un campo de salida; replica `NodeOutputFieldType`.
 *
 * NO es el tipo de TypeScript, es para que sirve. `url` y `url[]` son los que
 * consume el selector determinista del extractor web, que solo puede ofrecer
 * campos de los que salga una direccion: `character_count` es interpolable igual
 * que cualquier otro, pero ofrecerlo como origen de una URL seria exactamente el
 * error de tipeo que el selector viene a impedir.
 */
export type NodeOutputFieldType = 'url' | 'url[]' | 'text' | 'number' | 'boolean' | 'object';

/**
 * Campo del payload de un nodo, tal como se interpola.
 *
 * `name` va en `snake_case` porque asi viaja y asi se escribe en una plantilla
 * (`{{parsed_email.extracted_urls}}`).
 */
export interface NodeOutputField {
  readonly name: string;
  readonly type: NodeOutputFieldType;
  readonly description?: string;
}

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
 * enum declara ocho. Tiparlo como `NodeType` obligaria a mentir sobre
 * `DESTINO_ACENS`, que esta en la tabla precisamente por no ser expresable
 * todavia. `implemented` es la marca que separa unos de otros, y
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
  readonly outputFields: readonly NodeOutputField[];
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
