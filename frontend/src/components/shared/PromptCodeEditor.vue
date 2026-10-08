<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';

import { markerHighlighter } from '@/utils/codemirror-markers';
import { unuwareEditorTheme } from '@/utils/codemirror-theme';

import type { ViewUpdate } from '@codemirror/view';

/**
 * Editor de la instruccion de una plantilla de prompt.
 *
 * Hermano de `TemplateCodeEditor`, con el que comparte tema y resaltador de
 * marcadores, pero SIN la gramatica `html()` de Lezer ni el carril de
 * diagnosticos: el texto de un prompt es prosa con marcadores, no marcado, y
 * colorear sus angulos como etiquetas confundiria mas que ayudaria.
 *
 * Sustituye al `<q-input type="textarea">` anterior, que no resaltaba nada y
 * obligaba al anfitrion a manipular `selectionStart` del textarea nativo para
 * insertar un marcador. Aqui la insercion es una transaccion de CodeMirror, de
 * modo que `Ctrl+Z` la deshace entera.
 */
interface Props {
  modelValue: string;
  /** Altura minima del area de edicion. Un prompt es mas corto que una plantilla. */
  minHeight?: string;
}

const props = withDefaults(defineProps<Props>(), { minHeight: '220px' });

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const editorContainer = ref<HTMLDivElement | null>(null);

// El EditorView se guarda en una variable del setup y NO en un `ref`, por lo
// mismo que en `TemplateCodeEditor`: envolver una instancia imperativa con
// estado interno en un proxy reactivo de Vue es una fuente conocida de rarezas.
let view: EditorView | null = null;

const changeListener = EditorView.updateListener.of((update: ViewUpdate) => {
  if (!update.docChanged) return;

  emit('update:modelValue', update.state.doc.toString());
});

/**
 * Inserta texto en el cursor en UNA sola transaccion.
 *
 * Que el texto y el cursor viajen juntos es lo que permite que `Ctrl+Z`
 * deshaga la insercion completa de una vez, en lugar de dejar el caret
 * descolocado.
 */
const insertTextAtCursor = (text: string): void => {
  if (!view) return;

  const { from, to } = view.state.selection.main;

  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
  });

  // El clic en el boton del explorador robo el foco; se devuelve para poder
  // seguir escribiendo donde se estaba.
  view.focus();
};

watch(
  () => props.modelValue,
  (value) => {
    // Guarda contra el bucle de eco: sin esta comparacion, cada pulsacion haria
    // docChanged -> emit -> padre -> prop -> watch -> dispatch -> docChanged,
    // reemplazando el documento entero y perdiendo el cursor en cada tecla.
    if (!view || view.state.doc.toString() === value) return;

    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  },
);

onMounted(() => {
  if (!editorContainer.value) return;

  view = new EditorView({
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        unuwareEditorTheme,
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

defineExpose({ insertTextAtCursor });
</script>

<template>
  <div
    ref="editorContainer"
    class="pd-prompt-editor"
    data-test="prompt-code-editor"
    :style="{ minHeight: props.minHeight }"
  ></div>
</template>

<style scoped lang="scss">
.pd-prompt-editor {
  overflow: hidden;
  border: 1px solid var(--pd-border);
  border-radius: $generic-border-radius;
}

// `:deep()` es obligatorio: CodeMirror construye su DOM de forma imperativa,
// sin el atributo de scope que Vue anade a lo que el renderiza.
:deep(.cm-editor) {
  height: 100%;
}

// Mismo chip que en el editor de plantillas: es el mismo lenguaje y debe
// reconocerse igual en los dos sitios.
:deep(.cm-pd-template-marker) {
  background: var(--pd-accent-soft);
  color: var(--pd-accent);
  border: 1px solid var(--pd-accent);
  border-radius: 4px;
  padding: 1px 4px;
  font-weight: 600;
}
</style>
