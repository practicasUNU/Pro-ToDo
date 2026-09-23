<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useQuasar } from 'quasar';

import { useNodeCatalogStore } from '@stores/node-catalog.store';
import TemplateNodeCard from '@components/workflow-templates/TemplateNodeCard.vue';

import { extractApiErrorMessage } from '@/utils/api-error';

import { NODE_CATEGORY_LABELS } from '@/types/node-catalog';
import { withBaseParamDefaults } from '@/utils/node-base-params';

import { DEFAULT_OUTPUT_NAMESPACE_BY_NODE_TYPE } from '@/types/pipeline';

import type { AssemblerStep } from '@/utils/pipeline-assembler';
import type { NodeCatalogEntry } from '@/types/node-catalog';
import type { NodeType } from '@/types/pipeline';

interface Props {
  /** Secuencia actual, en orden de ejecucion. */
  modelValue: readonly AssemblerStep[];
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:modelValue': [value: AssemblerStep[]];
  'update:params': [nodeId: string, params: Record<string, unknown>];
}>();

const $q = useQuasar();
// Cero llamadas HTTP en el componente: todo pasa por el store (§2.1).
const catalogStore = useNodeCatalogStore();

/** Entrada elegida en el selector, antes de anadirla a la secuencia. */
const pendingEntry = ref<NodeCatalogEntry | null>(null);

/**
 * Opciones agrupadas por categoria.
 *
 * Se recorre el catalogo ENTERO y no solo los tipos ejecutables: los que no
 * tienen estrategia se muestran deshabilitados en vez de ocultarse, para que el
 * operador vea que existen y que aun no se pueden usar. Ocultarlos convertiria
 * una limitacion conocida en una ausencia inexplicable.
 *
 * `implemented` lo decide ahora el registro de estrategias del motor y no el
 * enum de tipos, asi que esta marca ya no deja pasar tipos que el motor no sabe
 * ejecutar.
 */
const groupedOptions = computed(() =>
  catalogStore.entries.map((entry) => ({
    entry,
    label: entry.name,
    category: NODE_CATEGORY_LABELS[entry.category],
    // Es `string | null` en el contrato del catalogo, asi que se propaga tal
    // cual y es la plantilla quien decide si hay linea que pintar.
    description: entry.description,
    disable: !entry.implemented,
  })),
);

const isCatalogEmpty = computed<boolean>(
  () => !catalogStore.isLoading && catalogStore.entries.length === 0,
);

/**
 * Deriva un `nodeId` libre a partir del codigo del tipo.
 *
 * Sirve SOLO para el `nodeId`. El `outputNamespace` sale de
 * `DEFAULT_OUTPUT_NAMESPACE_BY_NODE_TYPE` y no de aqui: aunque el codigo en
 * minusculas cumpla el patron del namespace, pertenecer a la lista blanca es
 * otra cosa, y reutilizar este valor dejaba a un TRIGGER_IMAP escribiendo en
 * `trigger_imap`, namespace que ninguna plantilla puede interpolar.
 *
 * El sufijo numerico cubre el caso real de dos nodos del mismo tipo en un flujo
 * (dos destinos HTTP, por ejemplo): sin el, el segundo pisaria la clave del
 * primero en `nodes`.
 */
const deriveNodeId = (code: string, taken: readonly string[]): string => {
  const base = code.toLowerCase();

  if (!taken.includes(base)) return base;

  let suffix = 2;
  while (taken.includes(`${base}_${suffix}`)) suffix += 1;

  return `${base}_${suffix}`;
};

const emitSequence = (steps: AssemblerStep[]): void => {
  emit('update:modelValue', steps);
};

/**
 * Anade el nodo elegido al final de la secuencia.
 *
 * El namespace por defecto NO se desambigua con un sufijo como el `nodeId`:
 * `http_result_2` no esta en la lista blanca y seria un valor invalido con
 * apariencia de valido. Dos nodos del mismo tipo comparten namespace a
 * proposito, el validador de topologia lo senala como duplicado y el operador
 * elige otro en el selector de la tarjeta, que solo ofrece valores legales.
 */
const addNode = (): void => {
  const entry = pendingEntry.value;

  if (entry === null || !entry.implemented) return;

  const nodeType = entry.code as NodeType;
  const nodeId = deriveNodeId(
    entry.code,
    props.modelValue.map((step) => step.nodeId),
  );

  emitSequence([
    ...props.modelValue,
    {
      nodeId,
      nodeType,
      outputNamespace: DEFAULT_OUTPUT_NAMESPACE_BY_NODE_TYPE[nodeType],
      // Devuelve un objeto NUEVO en cada alta: el mapa de defaults es un literal
      // compartido de modulo, y pasarlo por referencia haria que dos nodos del
      // mismo tipo acabaran escribiendo sobre el mismo `params`.
      params: withBaseParamDefaults(nodeType, {}),
    },
  ]);

  pendingEntry.value = null;
};

const removeNode = (index: number): void => {
  emitSequence(props.modelValue.filter((_, current) => current !== index));
};

/**
 * Mueve un nodo una posicion.
 *
 * Reordenar es lo que cambia `entrypoint` y toda la cadena de `nextStep`, asi
 * que se emite la secuencia entera y el anfitrion regenera el grafo.
 */
const moveNode = (index: number, offset: number): void => {
  const target = index + offset;

  if (target < 0 || target >= props.modelValue.length) return;

  const steps = [...props.modelValue];
  const [moved] = steps.splice(index, 1);

  if (moved === undefined) return;

  steps.splice(target, 0, moved);
  emitSequence(steps);
};

const updateNamespace = (index: number, value: string): void => {
  emitSequence(
    props.modelValue.map((step, current) =>
      current === index ? { ...step, outputNamespace: value } : step,
    ),
  );
};

onMounted(async () => {
  try {
    await catalogStore.fetchCatalog();
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo cargar el catalogo de nodos'),
    });
  }
});
</script>

<template>
  <section class="pd-sequence">
    <label class="pd-label" for="node-selector">Nodos del flujo</label>
    <p class="pd-subtitle q-mt-none q-mb-sm">
      El orden de la lista es la topologia: el primero es el punto de entrada y cada uno apunta al
      siguiente.
    </p>

    <!-- Selector cerrado (Poka-Yoke §4): sin entrada de texto libre, solo claves
         del catalogo que sirve el backend. -->
    <div class="row items-start q-gutter-sm q-mb-md">
      <q-select
        id="node-selector"
        v-model="pendingEntry"
        class="col"
        outlined
        dense
        emit-value
        map-options
        option-value="entry"
        option-label="label"
        option-disable="disable"
        :options="groupedOptions"
        :loading="catalogStore.isLoading"
        label="Anadir nodo"
      >
        <template #option="scope">
          <q-item v-bind="scope.itemProps">
            <q-item-section>
              <q-item-label>{{ scope.opt.label }}</q-item-label>
              <q-item-label caption class="pd-subtitle">
                {{ scope.opt.category }}
                <span v-if="scope.opt.disable"> · sin estrategia todavia</span>
              </q-item-label>
              <!--
                La descripcion llega del catalogo desde siempre y hasta ahora se
                descartaba. Va en su propia linea y con `v-if`: es anulable, y
                una linea vacia desalinearia el resto de opciones de la lista.
              -->
              <q-item-label v-if="scope.opt.description !== null" caption class="pd-subtitle">
                {{ scope.opt.description }}
              </q-item-label>
            </q-item-section>
          </q-item>
        </template>

        <template #no-option>
          <q-item>
            <q-item-section class="pd-subtitle">
              {{ isCatalogEmpty ? 'El catalogo esta vacio' : 'Sin resultados' }}
            </q-item-section>
          </q-item>
        </template>
      </q-select>

      <q-btn
        class="pd-btn-primary"
        unelevated
        no-caps
        icon-right="north_east"
        label="Anadir"
        :disable="pendingEntry === null"
        @click="addNode"
      />
    </div>

    <p v-if="props.modelValue.length === 0" class="pd-subtitle q-my-md">
      Todavia no hay nodos. Anade el primero para empezar a componer la topologia.
    </p>

    <q-list v-else bordered class="pd-sequence-list">
      <!-- Cada nodo es un bloque ESTRUCTURAL: orden, namespace y params base.
           Los formularios de configuracion viven solo en el asistente, donde el
           flujo concreto si necesita credenciales y parametros de operacion. -->
      <TemplateNodeCard
        v-for="(step, index) in props.modelValue"
        :key="step.nodeId"
        :step="step"
        :position="index + 1"
        :is-first="index === 0"
        :is-last="index === props.modelValue.length - 1"
        @move="moveNode(index, $event)"
        @remove="removeNode(index)"
        @update:namespace="updateNamespace(index, $event)"
        @update:params="emit('update:params', step.nodeId, $event)"
      />
    </q-list>
  </section>
</template>

<style scoped lang="scss">
.pd-sequence-list {
  border-color: var(--pd-border);
  border-radius: 8px;
  background: var(--pd-surface-muted);
}

.pd-sequence-item + .pd-sequence-item {
  border-top: 1px solid var(--pd-border);
}

:deep(.q-field--outlined .q-field__control) {
  background: var(--pd-card-bg);

  &::before {
    border-color: var(--pd-border);
  }
}
</style>
