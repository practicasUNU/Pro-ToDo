import { Decoration, MatchDecorator, ViewPlugin } from '@codemirror/view';

import type { EditorView } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';

// Extension de CodeMirror compartida por los dos editores que hablan el
// lenguaje `{{ns.campo}}`: el de plantillas HTML y el de instrucciones de IA.
//
// Vive aqui y no dentro de `TemplateCodeEditor.vue` porque el editor de prompts
// necesita exactamente este resaltado SIN la gramatica HTML de Lezer ni el
// carril de diagnosticos, que son especificos de una plantilla. Duplicarla
// habria dejado dos definiciones del mismo marcador que divergirian a la
// primera correccion de la gramatica.

/**
 * Marcador interpolable.
 *
 * Misma gramatica que `TEMPLATE_VARIABLE_PATTERN` del store de plantillas —el
 * indice `.[0]` incluido—, para que lo resaltado y lo que el backend extrae
 * como `requiredVariables` no puedan discrepar.
 */
export const MARKER_PATTERN = /\{\{\s*[a-zA-Z0-9_]+(?:\.(?:[a-zA-Z0-9_]+|\[\d+\]))+\s*\}\}/g;

/** Clase CSS del chip; cada editor la tematiza en su `:deep()`. */
export const MARKER_CLASS = 'cm-pd-template-marker';

const markerDecorator = new MatchDecorator({
  regexp: MARKER_PATTERN,
  decoration: Decoration.mark({ class: MARKER_CLASS }),
});

/** Pinta cada `{{ns.campo}}` como un chip dentro del propio editor. */
export const markerHighlighter = ViewPlugin.fromClass(
  class {
    public decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = markerDecorator.createDeco(view);
    }

    public update(update: ViewUpdate): void {
      this.decorations = markerDecorator.updateDeco(update, this.decorations);
    }
  },
  { decorations: (instance) => instance.decorations },
);
