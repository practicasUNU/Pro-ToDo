import { describe, expect, it } from 'vitest';

import { locateJsonPaths } from '@/utils/json-path-locator';

import type { SchemaIssue } from '@/types/pipeline';

/**
 * Documento con DOS nodos que comparten el nombre de clave `params`.
 *
 * Es el caso que separa un localizador correcto de un `indexOf`: la ruta
 * `nodes.mapeador.params` debe resolver al segundo `params`, no al primero.
 */
const DOC = JSON.stringify(
  {
    flowId: 'flujo-1',
    name: 'Notiweb',
    version: '1.0.0',
    entrypoint: 'trigger_imap',
    nodes: {
      trigger_imap: {
        nodeId: 'trigger_imap',
        nodeType: 'TRIGGER_IMAP',
        outputNamespace: 'raw_email',
        nextStep: 'mapeador',
        onErrorStep: null,
        params: { host: 'imap.unuware.com', mailbox: 'INBOX' },
      },
      mapeador: {
        nodeId: 'mapeador',
        nodeType: 'MAPEADOR_PLANTILLA',
        outputNamespace: 'rendered_html',
        nextStep: null,
        onErrorStep: null,
        params: { templateId: 'tpl-1' },
      },
    },
  },
  null,
  2,
);

/** Texto exacto que abarca el rango devuelto, para aseverar sin contar offsets. */
const sliceOf = (doc: string, range: { from: number; to: number }): string =>
  doc.slice(range.from, range.to);

const issue = (path: string, message = 'motivo'): SchemaIssue => ({ path, message });

describe('locateJsonPaths · rutas del validador sobre el documento JSON', () => {
  describe('1. Resolucion de rutas', () => {
    it('1.1 deberia localizar una clave de primer nivel', () => {
      // 2. Act
      const [range] = locateJsonPaths(DOC, [issue('version')]);

      // 3. Assert
      expect(range).toBeDefined();
      expect(sliceOf(DOC, range!)).toBe('"version"');
    });

    it('1.2 deberia descender hasta una clave anidada en un nodo', () => {
      // 2. Act
      const [range] = locateJsonPaths(DOC, [
        issue('nodes.trigger_imap.params.mailbox'),
      ]);

      // 3. Assert
      expect(range).toBeDefined();
      expect(sliceOf(DOC, range!)).toBe('"mailbox"');
    });

    it('1.3 deberia distinguir dos claves homonimas en ramas distintas', () => {
      // 1. Arrange: `templateId` solo existe dentro del segundo nodo.
      const [range] = locateJsonPaths(DOC, [
        issue('nodes.mapeador.params.templateId'),
      ]);

      // 3. Assert: si el descenso no acotara el ambito al nodo `mapeador`, el
      // primer `params` del documento capturaria la busqueda y el subrayado
      // caeria en el nodo equivocado.
      expect(range).toBeDefined();
      expect(sliceOf(DOC, range!)).toBe('"templateId"');
      expect(range!.from).toBeGreaterThan(DOC.indexOf('"mapeador"'));
    });

    it('1.4 deberia resolver el sentinela (root) al documento entero', () => {
      // 2. Act
      const [range] = locateJsonPaths(DOC, [issue('(root)')]);

      // 3. Assert: el backend lo usa cuando el payload no es ni un objeto JSON,
      // asi que no hay ninguna clave que senalar.
      expect(range).toEqual({ from: 0, to: DOC.length, message: 'motivo' });
    });
  });

  describe('2. Rutas irresolubles', () => {
    it('2.1 deberia descartar una ruta cuyo ultimo segmento no existe', () => {
      // 2. Act
      const ranges = locateJsonPaths(DOC, [
        issue('nodes.trigger_imap.params.inexistente'),
      ]);

      // 3. Assert: senalar el ultimo tramo que si se encontro (`params`) seria
      // subrayar la clave equivocada, que es peor que no subrayar nada.
      expect(ranges).toEqual([]);
    });

    it('2.2 deberia descartar una ruta cuyo nodo intermedio no existe', () => {
      // 2. Act
      const ranges = locateJsonPaths(DOC, [issue('nodes.no_existe.params.host')]);

      // 3. Assert
      expect(ranges).toEqual([]);
    });

    it('2.3 NO deberia buscar fuera del ambito del padre', () => {
      // 1. Arrange: `templateId` existe en el documento, pero NO dentro de
      // `trigger_imap`.
      const ranges = locateJsonPaths(DOC, [
        issue('nodes.trigger_imap.params.templateId'),
      ]);

      // 3. Assert: es la garantia que convierte el localizador en fiable. Sin el
      // corte por ambito, esta ruta resolveria al `templateId` del otro nodo.
      expect(ranges).toEqual([]);
    });

    it('2.4 deberia devolver [] sin issues', () => {
      expect(locateJsonPaths(DOC, [])).toEqual([]);
    });
  });

  describe('3. Contrato con CodeMirror', () => {
    it('3.1 deberia devolver los rangos ORDENADOS por posicion', () => {
      // 1. Arrange: se piden en orden inverso al que aparecen en el documento.
      const ranges = locateJsonPaths(DOC, [
        issue('nodes.mapeador.params.templateId'),
        issue('version'),
        issue('nodes.trigger_imap.params.host'),
      ]);

      // 3. Assert: CodeMirror exige los diagnosticos ordenados; entregarlos
      // desordenados hace que descarte los que van hacia atras.
      expect(ranges).toHaveLength(3);
      const offsets = ranges.map((range) => range.from);
      expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
    });

    it('3.2 deberia conservar un rango por CADA issue del mismo path', () => {
      // 1. Arrange: el backend emite un issue por regla incumplida.
      const ranges = locateJsonPaths(DOC, [
        issue('version', 'version debe ser una cadena.'),
        issue('version', 'version debe seguir el formato SemVer.'),
      ]);

      // 3. Assert: dos diagnosticos sobre el mismo rango, cada uno con su
      // mensaje, en vez de uno con los dos textos pegados.
      expect(ranges).toHaveLength(2);
      expect(ranges[0]?.from).toBe(ranges[1]?.from);
      expect(ranges[0]?.message).not.toBe(ranges[1]?.message);
    });
  });

  describe('4. Documentos hostiles', () => {
    it('4.1 no deberia descuadrarse con llaves dentro de una cadena', () => {
      // 1. Arrange: el asunto contiene una llave sin cerrar.
      const doc = JSON.stringify(
        {
          nodes: {
            trigger_imap: {
              params: { subjectFilter: 'Re: {urgente', mailbox: 'INBOX' },
            },
            otro: { params: { mailbox: 'ARCHIVO' } },
          },
        },
        null,
        2,
      );

      // 2. Act
      const [range] = locateJsonPaths(doc, [
        issue('nodes.trigger_imap.params.mailbox'),
      ]);

      // 3. Assert: si el recuento de llaves no ignorara las que van dentro de
      // una cadena, el ambito del primer nodo se cerraria antes de tiempo y la
      // busqueda saltaria al `mailbox` del nodo siguiente.
      expect(range).toBeDefined();
      expect(range!.from).toBeLessThan(doc.indexOf('"otro"'));
    });

    it('4.2 deberia tolerar un documento vacio sin lanzar', () => {
      expect(locateJsonPaths('', [issue('version')])).toEqual([]);
    });
  });
});
