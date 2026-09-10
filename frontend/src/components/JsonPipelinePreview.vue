<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { tags } from '@lezer/highlight';

import { locateJsonPaths } from '@/utils/json-path-locator';

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
 * Tema mapeado a los tokens del sistema.
 *
 * Se usan custom properties y no valores literales: como `--pd-*` conmuta solo
 * con `body--dark`, el editor sigue el tema sin reconfigurar extensiones ni
 * observar `$q.dark`. Es la misma decision que en `TemplateCodeEditor`.
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

/** Retira los diagnosticos sin tocar el documento. */
const clearDiagnostics = (target: EditorView): void => {
  target.dispatch(setDiagnostics(target.state, []));
};

const changeListener = EditorView.updateListener.of((update: ViewUpdate) => {
  if (!update.docChanged) return;

  emit('update:modelValue', update.state.doc.toString());

  // Los diagnosticos describen un documento que ya cambio: dejarlos visibles
  // senalaria posiciones desplazadas. No hay bucle porque `setDiagnostics`
  // despacha efectos de estado, no cambios de documento.
  clearDiagnostics(update.view);
});

/**
 * Pinta los campos invalidos que devolvio el backend.
 *
 * La traduccion de `path` a posicion la hace `locateJsonPaths`, que se resuelve
 * contra el TEXTO actual del editor y no contra el que se envio a validar: en
 * modo editable el operador puede haber seguido escribiendo, y una ruta que ya
 * no existe se descarta en vez de subrayar la clave equivocada.
 */
const applyDiagnostics = (issues: SchemaIssue[]): void => {
  if (!view) return;

  if (issues.length === 0) {
    clearDiagnostics(view);
    return;
  }

  const diagnostics: Diagnostic[] = locateJsonPaths(view.state.doc.toString(), issues).map(
    (range) => ({ ...range, severity: 'error' }),
  );

  view.dispatch(setDiagnostics(view.state, diagnostics));
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

// `deep` porque el anfitrion sustituye el arreglo entero al validar, pero
// tambien puede vaciarlo en sitio al limpiar.
watch(() => props.validationErrors, applyDiagnostics, { deep: true });

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
        unuwareTheme,
        changeListener,
      ],
    }),
    parent: editorContainer.value,
  });

  // Un anfitrion puede montar el visor con errores ya cargados (al reabrir un
  // dialogo, por ejemplo); sin esto no se pintarian hasta el siguiente cambio.
  applyDiagnostics(props.validationErrors);
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
