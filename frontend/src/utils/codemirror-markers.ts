import { Decoration, MatchDecorator, ViewPlugin } from '@codemirror/view';

import {
  isMandatoryMarker,
  MANDATORY_CHIP_CLASS,
  OPTIONAL_CHIP_CLASS,
  PROMPT_MARKER_PATTERN,
} from '@/utils/prompt-markers';

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

/** Plugin de resaltado a partir de un `MatchDecorator` cualquiera. */
const highlighterFrom = (decorator: MatchDecorator) =>
  ViewPlugin.fromClass(
    class {
      public decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = decorator.createDeco(view);
      }

      public update(update: ViewUpdate): void {
        this.decorations = decorator.updateDeco(update, this.decorations);
      }
    },
    { decorations: (instance) => instance.decorations },
  );

const markerDecorator = new MatchDecorator({
  regexp: MARKER_PATTERN,
  decoration: Decoration.mark({ class: MARKER_CLASS }),
});

/** Pinta cada `{{ns.campo}}` como un chip dentro del propio editor. */
export const markerHighlighter = highlighterFrom(markerDecorator);

// Decoraciones creadas una sola vez: `MatchDecorator` las pide por coincidencia
// y reutilizar la instancia evita reconstruirlas en cada tecla.
const mandatoryMark = Decoration.mark({ class: `${MARKER_CLASS} ${MANDATORY_CHIP_CLASS}` });
const optionalMark = Decoration.mark({ class: `${MARKER_CLASS} ${OPTIONAL_CHIP_CLASS}` });

// El `*` solo tiene semantica en prompts (ver `prompt-markers.ts`): en una
// plantilla HTML seria un residuo que el mapeador rechaza, por eso el editor de
// plantillas sigue con `markerHighlighter` y `MARKER_PATTERN`.
const promptMarkerDecorator = new MatchDecorator({
  regexp: PROMPT_MARKER_PATTERN,
  decoration: (match) => (isMandatoryMarker(match[0]) ? mandatoryMark : optionalMark),
});

/**
 * Resaltado del editor de prompts: chip rojo para las obligatorias y azul para
 * las opcionales. El asterisco queda visible dentro del chip, de modo que el
 * estado nunca se comunica solo por color.
 */
export const promptMarkerHighlighter = highlighterFrom(promptMarkerDecorator);
