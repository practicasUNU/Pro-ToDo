import { EditorView } from '@codemirror/view';

// Tema compartido por TODOS los editores de codigo del sistema.
//
// Vivia DUPLICADO byte a byte en `TemplateCodeEditor.vue` y en
// `JsonPipelinePreview.vue`. La paridad visual existia, pero por copia: la
// siguiente correccion de estilo se habria aplicado a uno solo de los dos y el
// marcado de errores habria divergido entre el CRUD de plantillas y el editor
// de pipelines, que es justo lo que no puede pasar —el operador tiene que
// reconocer un error como "un error" en cualquiera de las dos pantallas.
//
// Lo que NO se comparte es el resaltado de sintaxis (`HighlightStyle`): los
// tags de HTML (`tagName`, `attributeName`) y los de JSON (`propertyName`,
// `number`) son legitimamente distintos, y cada componente declara el suyo.

export const unuwareEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--pd-card-bg)',
    color: 'var(--pd-text-primary)',
    fontSize: '13px',
    border: '1px solid var(--pd-border)',
    borderRadius: '8px',
  },
  '.cm-scroller': {
    fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', Consolas, ui-monospace, monospace",
    lineHeight: '1.5',
  },
  '.cm-content': { caretColor: 'var(--pd-accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--pd-accent)' },
  '.cm-gutters': {
    backgroundColor: 'var(--pd-surface-muted)',
    color: 'var(--pd-disabled-text)',
    border: 'none',
    borderTopLeftRadius: '8px',
    borderBottomLeftRadius: '8px',
  },
  '.cm-activeLineGutter': { backgroundColor: 'var(--pd-surface-muted)' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  // CodeMirror pinta la seleccion en una capa propia cuando tiene el foco; hay
  // que cubrir ambos selectores o la seleccion desaparece al enfocar.
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--pd-accent-selection)',
  },
  // Diagnosticos. `background-image: none` es obligatorio: la ondulacion por
  // defecto de @codemirror/lint es un SVG en data URI con su propio rojo
  // incrustado, que ninguna propiedad de color puede retintar.
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--pd-negative)',
    textUnderlineOffset: '3px',
  },
  '.cm-lint-marker-error': { color: 'var(--pd-negative)' },
  '.cm-tooltip-lint': {
    backgroundColor: 'var(--pd-surface-muted)',
    border: '1px solid var(--pd-border)',
    borderRadius: '6px',
  },
  '.cm-diagnostic': {
    color: 'var(--pd-text-primary)',
    fontFamily: "'Inter Variable', 'Inter', Roboto, sans-serif",
    fontSize: '12.5px',
    padding: '4px 8px',
  },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--pd-negative)' },
});
