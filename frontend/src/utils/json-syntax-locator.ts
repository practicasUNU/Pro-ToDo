// Helper puro (frontend-architecture.md §2.1): transforma un dato en otro, sin
// estado ni I/O. Vive aqui y no dentro de `JsonPipelinePreview.vue` por el mismo
// motivo que sus hermanos `violation-matcher.ts` y `json-path-locator.ts`: su
// fallo seria silencioso —subrayar la linea equivocada no rompe nada visible— y
// desde `src/utils/` si se puede probar de forma aislada, cosa que un componente
// no permite (vitest corre con `environment: 'node'` y sin `@vue/test-utils`).

/** Rango a subrayar, en offsets absolutos. Misma forma que `IssueRange`. */
export interface SyntaxErrorRange {
  from: number;
  to: number;
  message: string;
}

/**
 * Lo que este helper necesita del documento de CodeMirror.
 *
 * Se declara como forma estructural en vez de importar `Text` de
 * `@codemirror/state`: asi la prueba construye un doble de tres propiedades y la
 * suite no arrastra CodeMirror. `view.state.doc` la cumple tal cual.
 *
 * Las lineas van 1-INDEXADAS, como en CodeMirror y como en el mensaje de V8.
 */
export interface DocumentLines {
  readonly lines: number;
  readonly length: number;
  readonly line: (lineNumber: number) => { from: number; to: number };
}

/**
 * Posicion extraida del mensaje de `SyntaxError`, si la trae.
 *
 * V8 NO es consistente: solo algunos mensajes incluyen `(line X column Y)`. El
 * resto se resuelve con la politica de reserva de `locateJsonSyntaxError`.
 */
const LINE_COLUMN_PATTERN = /\(line (\d+) column (\d+)\)/;

/**
 * Traduce el fallo de `JSON.parse` a un rango subrayable del documento.
 *
 * POR QUE NO BASTA CON PARSEAR LA LINEA Y LA COLUMNA: V8 moderno emite al menos
 * cuatro formas distintas, y solo dos llevan posicion.
 *
 * | Caso                | Mensaje                                                      |
 * |---------------------|--------------------------------------------------------------|
 * | Coma faltante       | `... in JSON at position 13 (line 3 column 3)`                |
 * | Comilla/clave mal   | `... in JSON at position 12 (line 3 column 1)`                |
 * | Token inesperado    | `Unexpected token ',', "{...}" is not valid JSON`  ← SIN pos. |
 * | Documento truncado  | `Unexpected end of JSON input`                     ← SIN pos. |
 *
 * El tercer caso es uno de los errores de tecleo mas frecuentes, asi que la
 * reserva no es un detalle: sin ella el error mas comun no se marcaria. Cuando
 * no hay posicion se subraya el DOCUMENTO ENTERO, que es la misma convencion
 * que `json-path-locator` aplica al centinela `(root)`. Es honesto: "hay un
 * fallo de sintaxis y no se sabe donde" en vez de senalar una linea al azar.
 *
 * @param doc Texto actual del editor.
 * @param lines Documento de CodeMirror, para resolver linea y columna a offset.
 * @returns El rango del fallo, o `null` si el texto parsea (o esta vacio).
 */
export const locateJsonSyntaxError = (
  doc: string,
  lines: DocumentLines,
): SyntaxErrorRange | null => {
  try {
    JSON.parse(doc);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'JSON invalido.';
    const match = LINE_COLUMN_PATTERN.exec(message);

    if (match === null) {
      return buildWholeDocumentRange(doc, message);
    }

    const lineNumber = Number(match[1]);
    const columnNumber = Number(match[2]);

    // V8 podria reportar una linea que el documento no tiene si el texto cambio
    // entre el parseo y esta llamada. `doc.line()` LANZA en ese caso, y una
    // excepcion aqui reventaria el editor entero por un subrayado.
    if (!Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > lines.lines) {
      return buildWholeDocumentRange(doc, message);
    }

    const line = lines.line(lineNumber);
    const from = line.from + Math.max(0, columnNumber - 1);

    // Un rango de anchura cero NO pinta nada: ni subrayado ni marcador. Y es el
    // caso frecuente, no el raro: V8 senala la coma que falta DESPUES del
    // ultimo caracter de la linea, asi que la columna cae exactamente en
    // `line.to`. Se subraya entonces la linea ENTERA, que es la informacion
    // util —"el fallo esta en esta linea"— en vez de una marca invisible.
    if (from >= line.to) {
      return line.from < line.to
        ? { from: line.from, to: line.to, message }
        : buildWholeDocumentRange(doc, message);
    }

    return { from, to: from + 1, message };
  }
};

/**
 * Reserva para los mensajes sin posicion: el documento entero.
 *
 * Un documento vacio devuelve `null` y no un rango de anchura cero: no hay nada
 * que subrayar, y CodeMirror pintaria un marcador invisible en el gutter que el
 * operador no podria relacionar con nada.
 */
const buildWholeDocumentRange = (doc: string, message: string): SyntaxErrorRange | null =>
  doc.length === 0 ? null : { from: 0, to: doc.length, message };
