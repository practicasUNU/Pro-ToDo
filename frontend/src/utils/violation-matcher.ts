import type { TemplateViolation } from '@/types/html-template';

// Helper puro (frontend-architecture.md §2.1): transforma un dato en otro, sin
// estado ni I/O. Vive aqui y no dentro de `TemplateCodeEditor.vue` porque es la
// pieza cuyo fallo seria silencioso —subrayar de menos o de mas no rompe nada
// visible— y desde `src/utils/` si se puede probar de forma aislada.

/** Neutraliza los metacaracteres de una cadena que se inserta en un `RegExp`. */
const escapeForRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Traduce el `target` de una infraccion al patron que la localiza en el HTML.
 *
 * Un `indexOf` del target produciria falsos positivos constantes: `<p` casa
 * dentro de `<pre>`, `onerror=` dentro de `data-onerror=`, y la palabra «body»
 * en un parrafo casa con la etiqueta. Cada tipo necesita su propia frontera.
 *
 * La forma del `target` la fija el backend segun el tipo (ver `TemplateViolation`):
 * normalizado en minusculas para el markup, y verbatim para las variables. De
 * ahi que solo el ultimo caso busque de forma literal y sensible a mayusculas.
 */
export const buildViolationPattern = (violation: TemplateViolation): RegExp => {
  const target = escapeForRegExp(violation.target);

  switch (violation.type) {
    // Apertura y cierre. El lookahead exige que el nombre termine ahi, que es
    // lo que impide que el tag `p` case dentro de `<pre>`.
    case 'tag':
      return new RegExp(`</?${target}(?=[\\s/>]|$)`, 'gi');

    // El lookbehind descarta los prefijos: `data-onerror=` no es `onerror=`.
    case 'attribute':
      return new RegExp(`(?<![\\w-])${target}(?=\\s*=)`, 'gi');

    case 'protocol':
      return new RegExp(target, 'gi');

    // Verbatim: el backend envia la subcadena tal y como esta en el documento.
    case 'variable':
      return new RegExp(target, 'g');
  }
};

/** Rango de texto a subrayar, en offsets absolutos del documento. */
export interface ViolationRange {
  from: number;
  to: number;
  message: string;
}

/**
 * Localiza todas las apariciones de cada infraccion dentro del documento.
 *
 * Se resuelve contra el TEXTO y no contra el arbol de sintaxis: el backend
 * devuelve identificadores (`body`, `onerror`), no posiciones, porque el HTML
 * que el parseo es el que se envio y no necesariamente el que hay ahora en
 * pantalla. Buscar el texto es lo unico que sigue funcionando si el autor ya
 * empezo a editar.
 *
 * @returns Rangos ordenados por posicion, como exige CodeMirror.
 */
export const locateViolations = (
  doc: string,
  violations: TemplateViolation[],
): ViolationRange[] => {
  const ranges: ViolationRange[] = [];

  for (const violation of violations) {
    const pattern = buildViolationPattern(violation);

    let match = pattern.exec(doc);

    while (match !== null) {
      ranges.push({
        from: match.index,
        to: match.index + match[0].length,
        message: violation.message,
      });

      match = pattern.exec(doc);
    }
  }

  // Se recorre una infraccion entera antes que la siguiente, asi que el orden
  // global no esta garantizado y CodeMirror exige los diagnosticos ordenados.
  return ranges.sort((left, right) => left.from - right.from);
};
