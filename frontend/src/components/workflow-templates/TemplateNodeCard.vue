<script setup lang="ts">
import { computed } from 'vue';

import { nodeBaseParamsRegistry } from '@components/nodes/node-base-params-registry';

import { NODE_OUTPUT_NAMESPACES } from '@/types/pipeline';

import type { AssemblerStep } from '@/utils/pipeline-assembler';

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
 * Control de parametros base que corresponde a ESTE tipo de nodo.
 *
 * Resolucion polimorfica contra el registro (frontend-quasar.md §3.1): la ficha
 * no compara `nodeType` con ninguna cadena, asi que dar de alta un tipo nuevo no
 * la obliga a cambiar. `undefined` para los tipos sin parametros base, y
 * entonces no se pinta ningun control.
 */
const baseParamsComponent = computed(() => nodeBaseParamsRegistry[props.step.nodeType]);
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

      <!-- Controles DEDICADOS, nunca JSON a mano (RNF-04). Una plantilla declara
           la topologia, y los parametros de operacion se piden en el asistente
           al instanciar el flujo; aqui solo se siembran valores base. Los tipos
           sin entrada en el registro no pintan nada, que es lo correcto: no
           tienen ningun parametro base que sembrar. -->
      <component
        :is="baseParamsComponent"
        v-if="baseParamsComponent"
        :params="props.step.params"
        :node-id="props.step.nodeId"
        @update:params="emit('update:params', $event)"
      />
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

// El campo del namespace vive ahora aqui, asi que su fondo tambien.
:deep(.q-field--outlined .q-field__control) {
  background: var(--pd-card-bg);

  &::before {
    border-color: var(--pd-border);
  }
}
</style>
