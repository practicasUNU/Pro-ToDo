import { describe, expect, it } from 'vitest';

import { locateJsonSyntaxError } from '@/utils/json-syntax-locator';

import type { DocumentLines } from '@/utils/json-syntax-locator';

/**
 * Doble de `Text` de CodeMirror sobre un string.
 *
 * Reproduce la aritmetica real: las lineas van 1-indexadas y `to` apunta al
 * final del texto de la linea, SIN incluir el salto. Construirlo a mano es lo
 * que permite probar el localizador sin arrastrar CodeMirror a la suite.
 */
const buildDoc = (text: string): DocumentLines => {
  const rawLines = text.split('\n');

  const offsets = rawLines.reduce<number[]>(
    (acc, line, index) => [...acc, (acc[index] ?? 0) + line.length + 1],
    [0],
  );

  return {
    lines: rawLines.length,
    length: text.length,
    line: (lineNumber: number) => {
      const from = offsets[lineNumber - 1] ?? 0;

      return { from, to: from + (rawLines[lineNumber - 1]?.length ?? 0) };
    },
  };
};

const locate = (text: string) => locateJsonSyntaxError(text, buildDoc(text));

/** Texto exacto que abarca el rango, para aseverar sin contar offsets a mano. */
const sliceOf = (text: string, range: { from: number; to: number }): string =>
  text.slice(range.from, range.to);

describe('locateJsonSyntaxError · fallos de sintaxis del editor JSON', () => {
  describe('1. Documento valido', () => {
    it('1.1 deberia devolver null cuando el JSON parsea', () => {
      // 1. Arrange & 2. Act & 3. Assert
      expect(locate('{\n  "a": 1\n}')).toBeNull();
    });

    it('1.2 deberia devolver null ante un documento vacio', () => {
      // No hay nada que subrayar; un rango de anchura cero pintaria un
      // marcador invisible que el operador no podria relacionar con nada.
      expect(locate('')).toBeNull();
    });
  });

  describe('2. Mensajes de V8 CON linea y columna', () => {
    it('2.1 deberia localizar una coma faltante en su linea', () => {
      // 1. Arrange: V8 dice `... at position 13 (line 3 column 3)`
      const text = '{\n  "a": 1\n  "b": 2\n}';

      // 2. Act
      const range = locate(text);

      // 3. Assert
      expect(range).not.toBeNull();
      expect(sliceOf(text, range!)).toBe('"');
      expect(range!.from).toBe(text.indexOf('"b"'));
    });

    it('2.2 deberia localizar una coma sobrante', () => {
      // 1. Arrange: `Expected double-quoted property name ... (line 3 column 1)`
      const text = '{\n  "a": 1,\n}';

      // 2. Act
      const range = locate(text);

      // 3. Assert
      expect(range).not.toBeNull();
      expect(range!.from).toBe(text.indexOf('}'));
    });

    // V8 senala la coma que falta DESPUES del ultimo caracter de la linea, asi
    // que `from` cae en `line.to` y un rango de anchura cero seria invisible.
    it('2.3 deberia subrayar la linea entera si la columna cae al final', () => {
      // 1. Arrange: V8 dice `(line 2 column 9)`, y la linea 2 mide 8 caracteres
      const text = '{\n  "a": 1';

      // 2. Act
      const range = locate(text);

      // 3. Assert: un rango de anchura cero no pintaria nada
      expect(range).not.toBeNull();
      expect(range!.to).toBeGreaterThan(range!.from);
      expect(sliceOf(text, range!)).toBe('  "a": 1');
    });
  });

  describe('3. Mensajes de V8 SIN posicion: reserva al documento entero', () => {
    // Es el error de tecleo mas frecuente y V8 dejo de dar su posicion: el
    // mensaje incrusta un fragmento del texto en vez de un offset.
    it('3.1 deberia marcar todo el documento ante un token inesperado', () => {
      // 1. Arrange
      const text = '{\n  "a": ,\n}';

      // 2. Act
      const range = locate(text);

      // 3. Assert
      expect(range).toEqual({
        from: 0,
        to: text.length,
        message: expect.stringContaining('Unexpected token'),
      });
    });

    it('3.2 deberia marcar todo el documento ante un final inesperado', () => {
      // 1. Arrange: solo espacios produce `Unexpected end of JSON input`, que
      // tampoco lleva posicion.
      const text = '   ';

      // 2. Act
      const range = locate(text);

      // 3. Assert
      expect(range).toEqual({
        from: 0,
        to: text.length,
        message: 'Unexpected end of JSON input',
      });
    });
  });

  describe('4. Contrato con CodeMirror', () => {
    it('4.1 deberia propagar el mensaje de V8 literal', () => {
      // El diagnostico que redacta V8 es mas preciso que cualquier frase fija.
      const range = locate('{\n  "a": 1\n  "b": 2\n}');

      expect(range?.message).toContain('Expected');
    });

    it('4.2 NUNCA deberia devolver un rango fuera del documento', () => {
      // Un `from`/`to` desbordado hace que CodeMirror lance al despachar, y eso
      // se lleva por delante el editor entero por un simple subrayado.
      const samples = ['{', '{\n"a":,\n}', '[1,]', '{"a" 1}', 'null,', '   '];

      for (const text of samples) {
        const range = locate(text);

        if (range === null) continue;

        expect(range.from).toBeGreaterThanOrEqual(0);
        expect(range.to).toBeLessThanOrEqual(text.length);
        expect(range.to).toBeGreaterThanOrEqual(range.from);
      }
    });
  });
});
