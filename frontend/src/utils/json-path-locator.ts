import type { SchemaIssue } from '@/types/pipeline';

// Helper puro (frontend-architecture.md §2.1): transforma un dato en otro, sin
// estado ni I/O. Vive aqui y no dentro de `JsonPipelinePreview.vue` por el mismo
// motivo que `violation-matcher.ts`: su fallo seria silencioso —subrayar la
// llave equivocada no rompe nada visible— y desde `src/utils/` si se puede
// probar de forma aislada, cosa que un componente no permite (vitest corre con
// `environment: 'node'` y sin `@vue/test-utils`).

/** Rango a subrayar, en offsets absolutos del documento. */
export interface IssueRange {
  from: number;
  to: number;
  message: string;
}

/** Neutraliza los metacaracteres de un segmento que se inserta en un `RegExp`. */
const escapeForRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Final del valor que abre en `openIndex`, equilibrando llaves y corchetes.
 *
 * Se ignoran las llaves que aparecen DENTRO de una cadena (`"{"` es un carácter,
 * no un nivel) y se respetan los escapes: sin esto, un `params` con un asunto
 * como `"Re: {urgente}"` descuadraría el recuento y el rango del objeto se
 * cerraría antes de tiempo.
 *
 * @returns El offset del cierre, o el final del documento si nunca equilibra.
 */
const findScopeEnd = (doc: string, openIndex: number): number => {
  const opener = doc[openIndex];

  if (opener !== '{' && opener !== '[') return doc.length;

  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let insideString = false;
  let escaped = false;

  for (let index = openIndex; index < doc.length; index += 1) {
    const char = doc[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      insideString = !insideString;
      continue;
    }

    if (insideString) continue;

    if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }

  return doc.length;
};

/** Rango [inicio, fin) del documento en el que buscar el siguiente segmento. */
interface SearchScope {
  start: number;
  end: number;
}

/**
 * Localiza la clave `segment` como token dentro del ámbito indicado.
 *
 * Se exige el patrón `"clave"` seguido de dos puntos, y no un `indexOf` del
 * nombre: buscar `mailbox` a secas casaría con el valor de otra clave, o con la
 * subcadena de `mailboxes`. El ámbito acotado es lo que impide, además, que una
 * clave homónima de otra rama del grafo capture el subrayado.
 *
 * @returns Rango de la clave y ámbito de su valor, o `null` si no aparece.
 */
const locateKey = (
  doc: string,
  segment: string,
  scope: SearchScope,
): { keyFrom: number; keyTo: number; valueScope: SearchScope } | null => {
  const pattern = new RegExp(`"${escapeForRegExp(segment)}"\\s*:`, 'g');
  pattern.lastIndex = scope.start;

  const match = pattern.exec(doc);

  if (match === null || match.index >= scope.end) return null;

  const keyFrom = match.index;
  const keyTo = keyFrom + segment.length + 2; // Las dos comillas.
  const valueStart = keyFrom + match[0].length;

  // El valor puede ser un objeto anidado (y entonces acota la busqueda del
  // segmento siguiente) o un escalar (y entonces no hay mas descenso posible).
  const firstMeaningful = doc.slice(valueStart).search(/\S/);
  const valueOpen = firstMeaningful === -1 ? valueStart : valueStart + firstMeaningful;

  return {
    keyFrom,
    keyTo,
    valueScope: { start: valueOpen, end: findScopeEnd(doc, valueOpen) },
  };
};

/**
 * Resuelve una ruta con puntos (`nodes.trigger_imap.params.mailbox`) a un rango.
 *
 * Descenso secuencial: cada segmento se busca dentro del ámbito que abrió el
 * anterior, de modo que `params` solo se busca dentro del nodo `trigger_imap` y
 * no en el primer `params` que aparezca en el documento.
 *
 * El sentinela `(root)` que el backend usa para "el payload entero no es un
 * objeto JSON" no es una ruta navegable: se resuelve al documento completo.
 *
 * @returns El rango de la clave, o `null` si la ruta no existe en el documento.
 */
const locatePath = (doc: string, path: string): { from: number; to: number } | null => {
  if (path === '(root)') {
    return { from: 0, to: doc.length };
  }

  const segments = path.split('.').filter((segment) => segment !== '');

  if (segments.length === 0) return null;

  let scope: SearchScope = { start: 0, end: doc.length };
  let range: { from: number; to: number } | null = null;

  for (const segment of segments) {
    const found = locateKey(doc, segment, scope);

    // Un segmento que no aparece hace irresoluble la ruta entera. Se descarta en
    // vez de subrayar el ultimo tramo que si se encontro: senalar la clave
    // equivocada es peor que no senalar nada.
    if (found === null) return null;

    range = { from: found.keyFrom, to: found.keyTo };
    scope = found.valueScope;
  }

  return range;
};

/**
 * Traduce los `issues` del backend a rangos subrayables del documento actual.
 *
 * Se resuelve contra el TEXTO y no contra el objeto parseado porque el editor es
 * editable: el documento en pantalla puede haber cambiado desde que se pidió la
 * validación, y buscar la ruta es lo único que sigue funcionando —o que falla
 * limpiamente— cuando eso ocurre.
 *
 * @returns Rangos ordenados por posición, como exige CodeMirror.
 */
export const locateJsonPaths = (doc: string, issues: SchemaIssue[]): IssueRange[] => {
  const ranges: IssueRange[] = [];

  for (const issue of issues) {
    const range = locatePath(doc, issue.path);

    if (range === null) continue;

    ranges.push({ from: range.from, to: range.to, message: issue.message });
  }

  return ranges.sort((left, right) => left.from - right.from);
};
