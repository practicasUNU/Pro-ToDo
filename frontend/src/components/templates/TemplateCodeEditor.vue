<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { html } from '@codemirror/lang-html';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';

import { locateViolations } from '@/utils/violation-matcher';

import type { Diagnostic } from '@codemirror/lint';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';

import type { TemplateViolation } from '@/types/html-template';

interface Props {
  modelValue: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
  cursorChange: [position: number];
}>();

const editorContainer = ref<HTMLDivElement | null>(null);

// El EditorView se guarda en una variable del setup y NO en un `ref`: envolver
// una instancia imperativa con estado interno en un proxy reactivo de Vue es una
// fuente conocida de rarezas, y aqui no se necesita reactividad sobre ella.
let view: EditorView | null = null;

/**
 * Marcador interpolable. Misma gramatica que `TEMPLATE_VARIABLE_PATTERN` del
 * store, para que lo resaltado y lo listado en los chips coincidan siempre.
 */
const MARKER_PATTERN = /\{\{\s*[a-zA-Z0-9_]+(?:\.(?:[a-zA-Z0-9_]+|\[\d+\]))+\s*\}\}/g;

/**
 * Tema mapeado a los tokens del sistema.
 *
 * Se usan custom properties y no valores literales: como `--pd-*` conmuta solo
 * con `body--dark`, el editor sigue el tema sin reconfigurar extensiones ni
 * observar `$q.dark`.
 */
const unuwareTheme = EditorView.theme({
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

/**
 * Resaltado de sintaxis sobre tokens ya existentes del sistema.
 *
 * No se usa `defaultHighlightStyle` de CodeMirror: esta pensado para fondo claro
 * y quedaria ilegible en el modo oscuro, que es el modo por defecto del
 * proyecto. Como estos tokens conmutan solos, UN unico estilo sirve para ambos.
 */
const unuwareHighlight = HighlightStyle.define([
  { tag: tags.tagName, color: 'var(--pd-accent-text)', fontWeight: '600' },
  { tag: tags.attributeName, color: 'var(--pd-primary-light)' },
  { tag: [tags.attributeValue, tags.string], color: 'var(--pd-positive)' },
  { tag: tags.comment, color: 'var(--pd-text-secondary)', fontStyle: 'italic' },
  { tag: [tags.angleBracket, tags.punctuation], color: 'var(--pd-text-secondary)' },
]);

/** Pinta cada `{{ns.campo}}` como un chip dentro del propio editor. */
const markerDecorator = new MatchDecorator({
  regexp: MARKER_PATTERN,
  decoration: Decoration.mark({ class: 'cm-pd-template-marker' }),
});

const markerHighlighter = ViewPlugin.fromClass(
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

/** Propaga los cambios del documento y del cursor hacia el padre. */
const changeListener = EditorView.updateListener.of((update: ViewUpdate) => {
  if (update.docChanged) {
    emit('update:modelValue', update.state.doc.toString());

    // Los diagnosticos describen un documento que ya cambio: dejarlos visibles
    // senalaria posiciones desplazadas. No hay bucle porque `setDiagnostics`
    // despacha efectos de estado, no cambios de documento.
    clearViolations(update.view);
  }

  if (update.selectionSet || update.docChanged) {
    emit('cursorChange', update.state.selection.main.head);
  }
});

/** Retira todo el subrayado de error de la vista dada. */
const clearViolations = (target: EditorView): void => {
  target.dispatch(setDiagnostics(target.state, []));
};

/**
 * Pinta en rojo las construcciones que el backend rechazo al guardar.
 *
 * La localizacion la resuelve `locateViolations`; aqui solo se traduce a la
 * forma que espera CodeMirror y se despacha.
 *
 * @param violations Infracciones del 400; un array vacio limpia el resaltado.
 */
const setViolations = (violations: TemplateViolation[]): void => {
  if (!view) return;

  if (violations.length === 0) {
    clearViolations(view);
    return;
  }

  const diagnostics: Diagnostic[] = locateViolations(
    view.state.doc.toString(),
    violations,
  ).map((range) => ({ ...range, severity: 'error' }));

  view.dispatch(setDiagnostics(view.state, diagnostics));
};

/**
 * Inserta texto en el cursor en UNA sola transaccion.
 *
 * Que el texto y el cursor viajen juntos es lo que permite que `Ctrl+Z` deshaga
 * la insercion completa de una vez, en lugar de dejar el caret descolocado.
 *
 * @param text Texto a insertar; reemplaza la seleccion si la hay.
 * @param cursorOffset Desplazamiento final del caret respecto al fin del texto.
 *        Con `-2` queda dentro de `{{namespace.|}}`, listo para escribir.
 */
const insertTextAtCursor = (text: string, cursorOffset = 0): void => {
  if (!view) return;

  const { from, to } = view.state.selection.main;

  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length + cursorOffset },
    scrollIntoView: true,
  });

  // El clic en el chip robo el foco; se devuelve para poder seguir tecleando.
  view.focus();
};

watch(
  () => props.modelValue,
  (value) => {
    // Guarda contra el bucle de eco: sin esta comparacion, cada pulsacion haria
    // docChanged -> emit -> store -> prop -> watch -> dispatch -> docChanged,
    // reemplazando el documento entero y perdiendo el cursor en cada tecla.
    if (!view || view.state.doc.toString() === value) return;

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  },
);

onMounted(() => {
  if (!editorContainer.value) return;

  view = new EditorView({
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        lineNumbers(),
        // Despues de `lineNumbers()` para que la columna de marcadores quede a
        // la derecha de los numeros de linea.
        lintGutter(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        html(),
        syntaxHighlighting(unuwareHighlight),
        EditorView.lineWrapping,
        unuwareTheme,
        markerHighlighter,
        changeListener,
      ],
    }),
    parent: editorContainer.value,
  });
});

onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});

defineExpose({ insertTextAtCursor, setViolations });
</script>

<template>
  <div ref="editorContainer" class="pd-code-editor"></div>
</template>

<style scoped lang="scss">
.pd-code-editor {
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

// `:deep()` es obligatorio: CodeMirror construye su DOM de forma imperativa, sin
// el atributo de scope que Vue anade a lo que el renderiza. Un selector scoped
// normal no alcanzaria a estos nodos; el contenedor si es de Vue, y por eso
// `:deep()` desde aqui funciona.
:deep(.cm-editor) {
  height: 100%;
}

:deep(.cm-pd-template-marker) {
  background: var(--pd-accent-soft);
  color: var(--pd-accent);
  border: 1px solid var(--pd-accent);
  border-radius: 4px;
  padding: 1px 4px;
  font-weight: 600;
}
</style>
