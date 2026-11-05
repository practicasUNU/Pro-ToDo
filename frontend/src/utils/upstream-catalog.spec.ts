import { describe, expect, it } from 'vitest';

import { buildContextForNamespaces, NODE_TYPE_BY_NAMESPACE } from './upstream-catalog';

import { NodeCategory } from '@/types/node-catalog';
import { NodeType } from '@/types/pipeline';

import type { NodeCatalogEntry, NodeOutputField } from '@/types/node-catalog';

const buildEntry = (code: NodeType, outputFields: NodeOutputField[]): NodeCatalogEntry => ({
  id: `id-${code}`,
  code,
  name: code,
  category: NodeCategory.PROCESAMIENTO,
  description: null,
  implemented: true,
  outputFields,
});

/**
 * Doble del `findByCode` del store: una busqueda en un arreglo.
 *
 * El helper recibe la busqueda por parametro precisamente para que la prueba no
 * necesite Pinia ni el catalogo real.
 */
const findIn =
  (entries: NodeCatalogEntry[]) =>
  (code: string): NodeCatalogEntry | null =>
    entries.find((entry) => entry.code === code) ?? null;

const PARSER_ENTRY = buildEntry(NodeType.PARSER_PRE_IA, [
  { name: 'clean_title', type: 'text', description: 'Titular saneado' },
  { name: 'extracted_urls', type: 'url[]' },
]);

describe('upstream-catalog · contexto de variables sin topologia', () => {
  describe('1. NODE_TYPE_BY_NAMESPACE', () => {
    it('1.1 deberia invertir el mapa de namespaces por defecto', () => {
      // 1. Arrange & 2. Act & 3. Assert
      expect(NODE_TYPE_BY_NAMESPACE.parsed_email).toBe(NodeType.PARSER_PRE_IA);
      expect(NODE_TYPE_BY_NAMESPACE.raw_email).toBe(NodeType.TRIGGER_IMAP);
      expect(NODE_TYPE_BY_NAMESPACE.rendered_html).toBe(NodeType.MAPEADOR_PLANTILLA);
    });

    it('1.2 no deberia declarar un tipo para un namespace que ningun nodo escribe', () => {
      // 1. Arrange & 2. Act & 3. Assert
      expect(NODE_TYPE_BY_NAMESPACE._assets).toBeUndefined();
    });
  });

  describe('2. buildContextForNamespaces', () => {
    it('2.1 deberia resolver los campos del catalogo por el tipo convencional', () => {
      // 1. Arrange & 2. Act
      const context = buildContextForNamespaces(['parsed_email'], findIn([PARSER_ENTRY]));

      // 3. Assert
      expect(context).toEqual([
        {
          namespace: 'parsed_email',
          nodeType: NodeType.PARSER_PRE_IA,
          fields: PARSER_ENTRY.outputFields,
        },
      ]);
    });

    it('2.2 deberia conservar el orden en que se piden los namespaces', () => {
      // 1. Arrange & 2. Act
      const context = buildContextForNamespaces(
        ['llm_response', 'parsed_email', 'raw_email'],
        findIn([PARSER_ENTRY]),
      );

      // 3. Assert: es el orden en que se ofreceran en el desplegable.
      expect(context.map(({ namespace }) => namespace)).toEqual([
        'llm_response',
        'parsed_email',
        'raw_email',
      ]);
    });

    it('2.3 deberia devolver campos vacios para un tipo que el catalogo no cubre', () => {
      // 1. Arrange & 2. Act: pasa con un tipo sin estrategia.
      const context = buildContextForNamespaces(['http_result'], findIn([]));

      // 3. Assert: vacio significa "no hay nada que ofrecer todavia", y el
      //    namespace sigue estando.
      expect(context).toEqual([
        { namespace: 'http_result', nodeType: NodeType.DESTINO_DRUPAL, fields: [] },
      ]);
    });

    it('2.4 deberia omitir nodeType en un namespace que ningun nodo escribe', () => {
      // 1. Arrange & 2. Act
      const [entry] = buildContextForNamespaces(['_assets'], findIn([]));

      // 3. Assert: la clave se OMITE, no se pone a `undefined`.
      expect(entry).not.toHaveProperty('nodeType');
    });

    it('2.5 deberia resolver _assets con su unico campo, sin tocar el catalogo', () => {
      // 1. Arrange: `_assets` no lo publica ningun nodo; lo inyecta el renderer.
      const findByCode = (): NodeCatalogEntry | null => {
        throw new Error('El catalogo no deberia consultarse para _assets');
      };

      // 2. Act
      const [entry] = buildContextForNamespaces(['_assets'], findByCode);

      // 3. Assert
      expect(entry?.fields.map((field) => field.name)).toEqual(['base_url']);
    });

    it('2.6 deberia tolerar un catalogo aun sin cargar', () => {
      // 1. Arrange & 2. Act: al abrir el dialogo antes de que llegue la peticion.
      const context = buildContextForNamespaces(['parsed_email', '_assets'], findIn([]));

      // 3. Assert: ni excepcion ni namespaces perdidos; solo sin campos que
      //    ofrecer, salvo los de `_assets`, que no dependen del catalogo.
      expect(context[0]?.fields).toEqual([]);
      expect(context[1]?.fields).toHaveLength(1);
    });

    it('2.7 deberia devolver un arreglo vacio sin namespaces que resolver', () => {
      // 1. Arrange & 2. Act & 3. Assert
      expect(buildContextForNamespaces([], findIn([]))).toEqual([]);
    });
  });
});
