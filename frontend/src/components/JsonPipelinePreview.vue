<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { tags } from '@lezer/highlight';

import { unuwareEditorTheme } from '@/utils/codemirror-theme';

import { locateJsonPaths } from '@/utils/json-path-locator';
import { locateJsonSyntaxError } from '@/utils/json-syntax-locator';

import type { Diagnostic } from '@codemirror/lint';
import type { ViewUpdate } from '@codemirror/view';

import type { SchemaIssue } from '@/types/pipeline';

interface Props {
  /** Documento JSON como TEXTO, no como objeto: es lo que el editor muestra. */
  modelValue: string;
  /** Campos invalidos devueltos por `POST /fsm/validate-schema`. */
  validationErrors?: SchemaIssue[];
  /**
   * Solo lectura por defecto.
   *
   * El visor nace como VISOR: mostrar el grafo que el asistente ensambla no
   * debe permitir editarlo a mano, porque el JSON lo genera el propio
   * asistente y una edicion manual se perderia al siguiente cambio de paso. El
   * editor de plantillas, donde el JSON SI es la fuente, lo pasa a `false`.
   */
  readonly?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  validationErrors: () => [],
  readonly: true,
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const editorContainer = ref<HTMLDivElement | null>(null);

// El EditorView se guarda en una variable del setup y NO en un `ref`: envolver
// una instancia imperativa con estado interno en un proxy reactivo de Vue es una
// fuente conocida de rarezas, y aqui no se necesita reactividad sobre ella.
let view: EditorView | null = null;

/**
 * Resaltado de sintaxis JSON sobre tokens ya existentes del sistema.
 *
 * No se usa `defaultHighlightStyle` de CodeMirror: esta pensado para fondo claro
 * y quedaria ilegible en el modo oscuro, que es el modo por defecto del
 * proyecto. Como estos tokens conmutan solos, UN unico estilo sirve para ambos.
 */
const unuwareHighlight = HighlightStyle.define([
  { tag: tags.propertyName, color: 'var(--pd-accent-text)', fontWeight: '600' },
  { tag: tags.string, color: 'var(--pd-positive)' },
  { tag: tags.number, color: 'var(--pd-primary-light)' },
  { tag: [tags.bool, tags.null], color: 'var(--pd-warning)', fontStyle: 'italic' },
  { tag: [tags.brace, tags.squareBracket, tags.separator], color: 'var(--pd-text-secondary)' },
]);

/**
 * Compone la lista COMPLETA de diagnosticos y la despacha de una sola vez.
 *
 * Un solo punto de despacho, y no uno por origen, porque `setDiagnostics`
 * REEMPLAZA la lista entera del estado: dos llamadas separadas se pisarian y la
 * segunda borraria lo que pinto la primera. Los dos origenes tienen que
 * fundirse aqui o no coexisten.
 *
 * PRECEDENCIA: si el documento no parsea, los `issues` del backend se
 * DESCARTAN. Describen un documento anterior que ya no existe, sus rutas no se
 * pueden resolver —`locateJsonPaths` las tiraria de todas formas— y ademas el
 * mensaje correcto para el operador es uno solo: arregla la sintaxis primero.
 *
 * El orden final es por `from`, como exige CodeMirror. Cada localizador ordena
 * lo suyo, pero la union de los dos no queda ordenada por construccion.
 *
 * @param issues Campos invalidos del backend; se ignoran si hay error de sintaxis.
 */
const refreshDiagnostics = (issues: SchemaIssue[]): void => {
  if (!view) return;

  const doc = view.state.doc.toString();
  const syntaxError = locateJsonSyntaxError(doc, view.state.doc);

  const ranges = syntaxError !== null ? [syntaxError] : locateJsonPaths(doc, issues);

  const diagnostics: Diagnostic[] = ranges
    .map((range) => ({ ...range, severity: 'error' as const }))
    .sort((left, right) => left.from - right.from);

  view.dispatch(setDiagnostics(view.state, diagnostics));
};

const changeListener = EditorView.updateListener.of((update: ViewUpdate) => {
  if (!update.docChanged) return;

  emit('update:modelValue', update.state.doc.toString());

  // Antes esto LIMPIABA los diagnosticos, y esa era la razon por la que un lint
  // de sintaxis local no podia existir: habria desaparecido con la tecla
  // siguiente. Ahora se RECALCULA, que es lo que hace que el subrayado aparezca
  // y desaparezca a medida que se escribe.
  //
  // Los `issues` del backend NO se reinyectan: describen el documento anterior.
  // El de sintaxis, en cambio, se recalcula sobre el texto que acaba de quedar.
  //
  // `queueMicrotask` saca el despacho del ciclo de actualizacion en curso.
  // Despachar desde dentro de un `updateListener` es reentrante y CodeMirror lo
  // desaconseja; limpiar era barato, pero recalcular y volver a pintar no lo
  // es. El microtask corre antes del siguiente repintado, asi que no hay
  // latencia perceptible.
  queueMicrotask(() => refreshDiagnostics([]));
});

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

// `deep` porque el anfitrion sustituye el arreglo entero al validar, pero
// tambien puede vaciarlo en sitio al limpiar.
watch(() => props.validationErrors, refreshDiagnostics, { deep: true });

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
        json(),
        syntaxHighlighting(unuwareHighlight),
        EditorView.lineWrapping,
        // `editable` y no `EditorState.readOnly`: readOnly tambien bloquea la
        // seleccion con teclado, y un visor tiene que dejar copiar el grafo.
        EditorView.editable.of(!props.readonly),
        unuwareEditorTheme,
        changeListener,
      ],
    }),
    parent: editorContainer.value,
  });

  // Un anfitrion puede montar el visor con errores ya cargados (al reabrir un
  // dialogo, por ejemplo); sin esto no se pintarian hasta el siguiente cambio.
  refreshDiagnostics(props.validationErrors);
});

onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});
</script>

<template>
  <div ref="editorContainer" class="pd-json-preview" />
</template>

<style scoped lang="scss">
.pd-json-preview {
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
</style>
