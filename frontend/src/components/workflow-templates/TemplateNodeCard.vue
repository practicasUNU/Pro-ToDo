<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue';

import {
  areParamsEqual,
  parseParamsObject,
  stringifyParams,
} from '@/utils/params-json';

import { NODE_OUTPUT_NAMESPACES } from '@/types/pipeline';

import type { AssemblerStep } from '@/utils/pipeline-assembler';

// CodeMirror pesa cientos de KB y solo hace falta al desplegar un nodo; en
// diferido se descarga una unica vez para todos los que se abran.
const JsonPipelinePreview = defineAsyncComponent(
  () => import('@components/JsonPipelinePreview.vue'),
);

interface Props {
  /** Paso que este bloque representa. */
  step: AssemblerStep;
  /** Posicion 1..n, solo para la insignia de la cabecera. */
  position: number;
  isFirst: boolean;
  isLast: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  /** Desplazamiento relativo: -1 sube, +1 baja. */
  move: [offset: number];
  remove: [];
  'update:namespace': [value: string];
  'update:params': [params: Record<string, unknown>];
}>();

/**
 * Texto EN CURSO del editor.
 *
 * Vive aqui y no en el anfitrion a proposito: un JSON a medio escribir no es un
 * dato del grafo, y elevarlo obligaria al constructor a distinguir el texto
 * valido del que todavia no parsea. Ademas muere con la instancia, lo que evita
 * que el texto de un nodo borrado reaparezca en otro nodo que reutilice su
 * `nodeId`.
 */
const paramsText = ref<string>(stringifyParams(props.step.params));

const paramsError = computed<string | null>(() => {
  const result = parseParamsObject(paramsText.value);

  return result.ok ? null : result.message;
});

/**
 * Publica SOLO lo que parsea.
 *
 * Emitir a medio escribir regeneraria el grafo entero en cada pulsacion y el
 * documento resultante volveria aqui, borrando lo tecleado.
 */
const onParamsTextChange = (value: string): void => {
  paramsText.value = value;

  const result = parseParamsObject(value);

  if (result.ok) {
    emit('update:params', result.value);
  }
};

/**
 * Guarda de eco.
 *
 * El anfitrion devuelve el mismo objeto que acabamos de emitir; reserializarlo
 * destruiria el formato del autor y la posicion de su cursor. Solo se repone el
 * texto cuando el valor entrante es OTRO, que es lo que ocurre al reabrir el
 * dialogo con una plantilla distinta que reutiliza este `nodeId`.
 */
watch(
  () => props.step.params,
  (incoming) => {
    const current = parseParamsObject(paramsText.value);

    if (current.ok && areParamsEqual(current.value, incoming)) return;

    paramsText.value = stringifyParams(incoming);
  },
);
</script>

<template>
  <q-expansion-item class="pd-sequence-item" expand-separator>
    <template #header>
      <q-item-section avatar>
        <q-badge class="pd-badge">{{ props.position }}</q-badge>
      </q-item-section>

      <q-item-section>
        <q-item-label class="pd-mono">{{ props.step.nodeId }}</q-item-label>
        <q-item-label caption class="pd-mono pd-sequence-namespace">
          {{ props.step.outputNamespace }}
        </q-item-label>
      </q-item-section>

      <!-- El aviso va en la CABECERA para que siga viendose con el nodo
           plegado: un JSON roto no impide guardar, asi que si solo se pintase
           dentro del panel el operador podria persistir sin enterarse. -->
      <q-item-section v-if="paramsError" side>
        <q-badge class="pd-badge pd-params-badge--error">JSON invalido</q-badge>
      </q-item-section>

      <q-item-section side>
        <div class="row no-wrap q-gutter-xs">
          <q-btn
            class="pd-btn-icon"
            outline
            dense
            size="sm"
            icon="arrow_upward"
            :disable="props.isFirst"
            :aria-label="`Subir ${props.step.nodeId}`"
            @click.stop="emit('move', -1)"
          />
          <q-btn
            class="pd-btn-icon"
            outline
            dense
            size="sm"
            icon="arrow_downward"
            :disable="props.isLast"
            :aria-label="`Bajar ${props.step.nodeId}`"
            @click.stop="emit('move', 1)"
          />
          <q-btn
            class="pd-btn-icon pd-btn-icon--danger"
            outline
            dense
            size="sm"
            icon="close"
            :aria-label="`Quitar ${props.step.nodeId}`"
            @click.stop="emit('remove')"
          />
        </div>
      </q-item-section>
    </template>

    <div class="pd-sequence-body q-pa-md">
      <label class="pd-label" :for="`namespace-${props.step.nodeId}`">
        Namespace de salida<span class="pd-required">*</span>
      </label>
      <!-- Selector CERRADO, no entrada libre: el validador de topologia del
           backend solo acepta los namespaces de la lista blanca, y teclearlos
           a mano solo servia para descubrirlo con un 400 al guardar. -->
      <q-select
        :id="`namespace-${props.step.nodeId}`"
        :model-value="props.step.outputNamespace"
        :options="NODE_OUTPUT_NAMESPACES"
        outlined
        dense
        emit-value
        map-options
        class="q-mt-xs q-mb-md pd-mono"
        @update:model-value="emit('update:namespace', String($event ?? ''))"
      />

      <!-- Editor crudo para TODOS los tipos: una plantilla declara la topologia,
           y los parametros de operacion se piden en el asistente al instanciar
           el flujo. Aqui solo se siembran valores base opcionales. -->
      <div class="pd-sequence-json">
        <div class="row items-center justify-between q-mb-xs">
          <span class="pd-label">Parametros base (JSON)</span>
          <span v-if="paramsError" class="pd-mono pd-sequence-error">{{ paramsError }}</span>
        </div>
        <p class="pd-subtitle q-mt-none q-mb-sm">
          Opcionales. Deja <span class="pd-mono">{}</span> si el nodo no necesita ninguno: el
          asistente pedira los parametros de operacion al crear el flujo.
        </p>
        <JsonPipelinePreview
          :model-value="paramsText"
          :readonly="false"
          @update:model-value="onParamsTextChange"
        />
      </div>
    </div>
  </q-expansion-item>
</template>

<style scoped lang="scss">
.pd-sequence-namespace {
  color: var(--pd-text-secondary);
}

.pd-sequence-body {
  background: var(--pd-card-bg);
}

// Altura acotada: el editor de `params` vive dentro de una columna que ya
// scrollea, asi que sin un techo cada nodo desplegado empujaria a los demas
// fuera de la vista.
.pd-sequence-json :deep(.pd-json-preview) {
  height: 220px;
}

.pd-sequence-error {
  color: var(--pd-negative);
  font-size: 11.5px;
}

// El campo del namespace vive ahora aqui, asi que su fondo tambien.
:deep(.q-field--outlined .q-field__control) {
  background: var(--pd-card-bg);

  &::before {
    border-color: var(--pd-border);
  }
}

.pd-params-badge--error {
  background: var(--pd-negative);
  color: #ffffff;
}
</style>
