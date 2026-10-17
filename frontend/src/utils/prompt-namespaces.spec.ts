import { describe, expect, it } from 'vitest';

import {
  PROMPT_EXCLUDED_NODE_TYPES,
  buildPromptContextFromCatalog,
  filterPromptContext,
} from './prompt-namespaces';

import { NodeCategory } from '@/types/node-catalog';
import { NodeType } from '@/types/pipeline';

import type { NodeCatalogEntry, NodeOutputField } from '@/types/node-catalog';
import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

const FIELD: NodeOutputField = { name: 'clean_body', type: 'text' };

const buildEntry = (overrides: Partial<NodeCatalogEntry> = {}): NodeCatalogEntry => ({
  id: 'e1',
  code: NodeType.PARSER_PRE_IA,
  name: 'Parser de Correo',
  category: NodeCategory.PROCESAMIENTO,
  description: null,
  implemented: true,
  outputFields: [FIELD],
  ...overrides,
});

/**
 * Replica las ONCE filas reales del catalogo.
 *
 * Tenia nueve y le faltaban `PROCESADOR_OCR` y `DESTINO_SMTP`, que son
 * justamente los dos casos que importa fijar: el OCR es el origen que mas se
 * discute —transcribe PARA que un prompt posterior lea— y el SMTP es el segundo
 * destino, la prueba de que la exclusion por categoria no depende de acordarse
 * de ningun nombre.
 */
const FULL_CATALOG: NodeCatalogEntry[] = [
  buildEntry({ id: '1', code: NodeType.TRIGGER_IMAP, category: NodeCategory.TRIGGER }),
  buildEntry({ id: '2', code: NodeType.TRIGGER_CRON, category: NodeCategory.TRIGGER }),
  buildEntry({ id: '3', code: NodeType.PARSER_PRE_IA }),
  buildEntry({ id: '4', code: NodeType.EXTRACTOR_WEB }),
  buildEntry({ id: '5', code: NodeType.PROCESADOR_IA, outputFields: [] }),
  buildEntry({
    id: '6',
    code: NodeType.ESCUDO_POST_IA,
    category: NodeCategory.CONTROL,
    outputFields: [],
  }),
  buildEntry({ id: '7', code: NodeType.MAPEADOR_PLANTILLA }),
  buildEntry({ id: '8', code: NodeType.DESTINO_DRUPAL, category: NodeCategory.DESTINO }),
  buildEntry({ id: '9', code: 'DESTINO_ACENS', category: NodeCategory.DESTINO, outputFields: [] }),
  buildEntry({ id: '10', code: NodeType.PROCESADOR_OCR }),
  buildEntry({ id: '11', code: NodeType.DESTINO_SMTP, category: NodeCategory.DESTINO }),
];

const namespacesOf = (context: readonly UpstreamNamespace[]): string[] =>
  context.map(({ namespace }) => namespace);

describe('prompt-namespaces · filtro Poka-Yoke de origenes', () => {
  describe('1. Escenario A: catalogo global', () => {
    it('1.1 deberia dejar exactamente los siete origenes citables', () => {
      // 1. Arrange & 2. Act
      const context = buildPromptContextFromCatalog(FULL_CATALOG);

      // 3. Assert: es el contrato completo de la vista general. Si alguien
      //    anade un nodo al catalogo, esta lista lo delata antes que la UI.
      //    `rendered_html` entro con el cambio de semantica del mapeador;
      //    `ocr_result` es el origen cuya razon de ser es ser citado —el OCR
      //    transcribe para que un prompt posterior lea lo transcrito—; y
      //    `smtp_result` entra pese a ser un DESTINO porque cuelga de un
      //    `onErrorStep` y no del camino feliz, de modo que una rama de
      //    recuperacion posterior puede citar el acuse del aviso.
      expect(namespacesOf(context)).toEqual([
        'raw_email',
        'cron_trigger',
        'parsed_email',
        'scraped_web',
        'rendered_html',
        'ocr_result',
        'smtp_result',
      ]);
    });

    it('1.1bis deberia ofrecer el OCR y el acuse SMTP, y callar el destino final', () => {
      // 1. Arrange & 2. Act
      const namespaces = namespacesOf(buildPromptContextFromCatalog(FULL_CATALOG));

      // 3. Assert 🎯: se nombran los namespaces REALES de los destinos, que no
      //    son `destino_drupal` ni `destino_smtp` —esos no existen— sino
      //    `http_result` y `smtp_result`. Una exclusion escrita contra los
      //    nombres equivocados no filtraria nada y lo pareceria.
      //
      //    `http_result` sigue fuera y `smtp_result` entra: la diferencia no es
      //    la categoria, que es la misma, sino donde vive cada uno. Drupal
      //    CIERRA el flujo; el aviso por correo es un satelite de contingencia.
      expect(namespaces).toContain('ocr_result');
      expect(namespaces).toContain('smtp_result');
      expect(namespaces).not.toContain('http_result');
      expect(namespaces).not.toContain('llm_response');
      expect(namespaces).not.toContain('validated_drupal_json');
    });

    it('1.2 deberia excluir los destinos por CATEGORIA y no por nombre', () => {
      // 1. Arrange: un destino inventado que no esta en ninguna lista de tipos.
      const catalog = [buildEntry({ code: 'DESTINO_FUTURO', category: NodeCategory.DESTINO })];

      // 2. Act
      const context = buildPromptContextFromCatalog(catalog);

      // 3. Assert: enumerarlos habria obligado a acordarse de la lista al
      //    anadir el tercer destino.
      expect(context).toEqual([]);
    });

    it('1.3 deberia OFRECER el mapeador, que ahora precede a la IA', () => {
      // 1. Arrange & 2. Act
      const context = buildPromptContextFromCatalog(FULL_CATALOG);

      // 3. Assert: INVERSA de la regla anterior, y a proposito. Mientras el
      //    nodo compilaba iba detras y citarlo era imposible; desde el cambio
      //    de semantica publica el esqueleto que la instruccion debe mandar
      //    rellenar, asi que esconderlo obligaba a teclear el marcador a mano.
      expect(namespacesOf(context)).toContain('rendered_html');
    });

    it('1.4 deberia excluir la propia salida de la IA', () => {
      // 1. Arrange: con campos declarados, para que no se caiga por el otro
      //    filtro y la prueba mida lo que dice medir.
      const catalog = [buildEntry({ code: NodeType.PROCESADOR_IA, outputFields: [FIELD] })];

      // 2. Act
      const context = buildPromptContextFromCatalog(catalog);

      // 3. Assert: un prompt que cita `llm_response` se pide a si mismo.
      expect(context).toEqual([]);
    });

    it('1.5 deberia omitir los nodos que no declaran campos', () => {
      // 1. Arrange
      const catalog = [buildEntry({ code: NodeType.EXTRACTOR_WEB, outputFields: [] })];

      // 2. Act
      const context = buildPromptContextFromCatalog(catalog);

      // 3. Assert: elegirlo dejaria el segundo selector vacio sin explicar por
      //    que. Es el estado de PROCESADOR_IA y ESCUDO_POST_IA hoy.
      expect(context).toEqual([]);
    });

    it('1.6 no deberia reventar con el catalogo vacio', () => {
      // 1. Arrange & 2. Act & 3. Assert: es el estado mientras viaja la peticion.
      expect(buildPromptContextFromCatalog([])).toEqual([]);
    });
  });

  describe('2. Escenario B: contexto del flujo', () => {
    it('2.1 deberia conservar los origenes legitimos que anteceden al nodo', () => {
      // 1. Arrange
      const upstream: UpstreamNamespace[] = [
        { namespace: 'raw_email', nodeType: NodeType.TRIGGER_IMAP, fields: [FIELD] },
        { namespace: 'parsed_email', nodeType: NodeType.PARSER_PRE_IA, fields: [FIELD] },
      ];

      // 2. Act
      const context = filterPromptContext(upstream);

      // 3. Assert
      expect(namespacesOf(context)).toEqual(['raw_email', 'parsed_email']);
    });

    it('2.2 deberia caerse el escudo aunque el flujo lo coloque antes', () => {
      // 1. Arrange: topologia legal pero origen sin sentido para la instruccion,
      //    porque el escudo valida la salida que esta misma inferencia produce.
      const upstream: UpstreamNamespace[] = [
        { namespace: 'parsed_email', nodeType: NodeType.PARSER_PRE_IA, fields: [FIELD] },
        {
          namespace: 'validated_drupal_json',
          nodeType: NodeType.ESCUDO_POST_IA,
          fields: [FIELD],
        },
      ];

      // 2. Act
      const context = filterPromptContext(upstream);

      // 3. Assert
      expect(namespacesOf(context)).toEqual(['parsed_email']);
    });

    it('2.5 deberia conservar el mapeador colocado delante de la IA', () => {
      // 1. Arrange: es la topologia PREVISTA desde el cambio de semantica, no
      //    una rareza que haya que tolerar.
      const upstream: UpstreamNamespace[] = [
        { namespace: 'parsed_email', nodeType: NodeType.PARSER_PRE_IA, fields: [FIELD] },
        { namespace: 'rendered_html', nodeType: NodeType.MAPEADOR_PLANTILLA, fields: [FIELD] },
      ];

      // 2. Act
      const context = filterPromptContext(upstream);

      // 3. Assert
      expect(namespacesOf(context)).toEqual(['parsed_email', 'rendered_html']);
    });

    it('2.3 no deberia mutar el arreglo recibido', () => {
      // 1. Arrange: el contexto lo posee `flujo-draft.store`, y devolverlo por
      //    referencia dejaria que el dialogo le escribiera encima.
      const upstream: UpstreamNamespace[] = [
        { namespace: 'parsed_email', nodeType: NodeType.PARSER_PRE_IA, fields: [FIELD] },
      ];

      // 2. Act
      const context = filterPromptContext(upstream);

      // 3. Assert
      expect(context[0]).not.toBe(upstream[0]);
      expect(context[0]).toEqual(upstream[0]);
    });

    it('2.4 deberia dejar pasar un origen sin nodeType declarado', () => {
      // 1. Arrange: `_assets` y compania no los escribe ningun nodo, asi que no
      //    hay tipo contra el que excluir. Se deja pasar en vez de suponer.
      const upstream: UpstreamNamespace[] = [{ namespace: '_assets', fields: [FIELD] }];

      // 2. Act & 3. Assert
      expect(namespacesOf(filterPromptContext(upstream))).toEqual(['_assets']);
    });
  });

  describe('3. La lista de exclusiones', () => {
    it('3.1 deberia cubrir los dos tipos nominales', () => {
      // 1. Arrange & 2. Act & 3. Assert: los destinos NO estan aqui a
      //    proposito; se excluyen por categoria. Y el MAPEADOR_PLANTILLA
      //    tampoco: salio de la lista al pasar a ejecutarse ANTES de la IA.
      expect([...PROMPT_EXCLUDED_NODE_TYPES].sort()).toEqual([
        NodeType.ESCUDO_POST_IA,
        NodeType.PROCESADOR_IA,
      ]);
    });
  });
});
