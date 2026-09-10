<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue';
import { useQuasar } from 'quasar';

import { nodeConfigRegistry } from '@components/nodes/node-config-registry';
import { useNodeCatalogStore } from '@stores/node-catalog.store';
import { resolveNodeStore } from '@stores/nodes/node-store-registry';

import { extractApiErrorMessage } from '@/utils/api-error';

import { NODE_CATEGORY_LABELS } from '@/types/node-catalog';

import type { AssemblerStep } from '@/utils/pipeline-assembler';
import type { NodeCatalogEntry } from '@/types/node-catalog';
import type { NodeType } from '@/types/pipeline';

// Mismo motivo que en el dialogo anfitrion: CodeMirror pesa cientos de KB y solo
// hace falta cuando se despliega un nodo SIN configurador dedicado.
const JsonPipelinePreview = defineAsyncComponent(
  () => import('@components/JsonPipelinePreview.vue'),
);

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

/** Texto JSON de los `params` por nodo, para los tipos sin configurador. */
const paramsText = ref<Record<string, string>>({});

/**
 * Opciones agrupadas por categoria.
 *
 * Se recorre el catalogo ENTERO y no `selectableEntries`: los tipos sin
 * estrategia se muestran deshabilitados en vez de ocultarse, para que el
 * operador vea que existen y que aun no se pueden usar. Ocultarlos convertiria
 * una limitacion conocida en una ausencia inexplicable.
 */
const groupedOptions = computed(() =>
  catalogStore.entries.map((entry) => ({
    entry,
    label: entry.name,
    category: NODE_CATEGORY_LABELS[entry.category],
    disable: !entry.implemented,
  })),
);

const isCatalogEmpty = computed<boolean>(
  () => !catalogStore.isLoading && catalogStore.entries.length === 0,
);

/** Componente dedicado del tipo, o `undefined` si toca el editor JSON. */
const configComponentFor = (nodeType: NodeType) => nodeConfigRegistry[nodeType];

/**
 * Deriva un `nodeId` libre a partir del codigo del tipo.
 *
 * El codigo en minusculas ya cumple el patron de `outputNamespace`
 * (`^[a-z0-9_]+$`), asi que sirve para los dos campos. El sufijo numerico cubre
 * el caso real de dos nodos del mismo tipo en un flujo (dos destinos HTTP, por
 * ejemplo): sin el, el segundo pisaria la clave del primero en `nodes`.
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

const addNode = (): void => {
  const entry = pendingEntry.value;

  if (entry === null || !entry.implemented) return;

  const nodeId = deriveNodeId(
    entry.code,
    props.modelValue.map((step) => step.nodeId),
  );

  emitSequence([
    ...props.modelValue,
    {
      nodeId,
      nodeType: entry.code as NodeType,
      outputNamespace: nodeId,
      params: {},
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

/**
 * Publica los `params` que el operador escribio en el editor JSON del nodo.
 *
 * Solo se emiten si el texto PARSEA: propagar un objeto a medio escribir
 * regeneraria el grafo entero en cada pulsacion y borraria lo tecleado. Mientras
 * no parsee, el texto se conserva en `paramsText` y el nodo muestra su error.
 */
const onParamsTextChange = (nodeId: string, value: string): void => {
  paramsText.value = { ...paramsText.value, [nodeId]: value };

  try {
    const parsed: unknown = JSON.parse(value);

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;

    emit('update:params', nodeId, parsed as Record<string, unknown>);
  } catch {
    // Silencio deliberado: el error se pinta con `paramsErrorFor`, no aqui.
  }
};

const paramsErrorFor = (nodeId: string): string | null => {
  const text = paramsText.value[nodeId];

  if (text === undefined) return null;

  try {
    const parsed: unknown = JSON.parse(text);

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? null
      : 'Los params deben ser un objeto JSON.';
  } catch (error) {
    return error instanceof Error ? error.message : 'JSON invalido.';
  }
};

const paramsTextFor = (step: AssemblerStep): string =>
  paramsText.value[step.nodeId] ?? JSON.stringify(step.params, null, 2);

/**
 * Recoge los `params` del configurador dedicado y los sube al anfitrion.
 *
 * El anfitrion PREGUNTA al store del nodo con `toNodeParams()` en vez de
 * inspeccionar su config (§3.1). Hace falta un disparo explicito porque los
 * componentes de nodo no emiten cambios: escriben en su propio store, que es su
 * unica salida.
 */
const syncFromNodeStore = (step: AssemblerStep): void => {
  const store = resolveNodeStore(step.nodeType, step.nodeId);

  if (store === null) return;

  emit('update:params', step.nodeId, store.toNodeParams());
};

/**
 * Reparte los namespaces aguas arriba a cada store con configurador.
 *
 * Es el mismo contrato que cumple el asistente: el mapeador necesita saber que
 * namespaces existen ANTES de que el operador abra su formulario, o su primera
 * validacion se haria contra una lista vacia.
 */
const syncUpstreamNamespaces = (): void => {
  props.modelValue.forEach((step, index) => {
    resolveNodeStore(step.nodeType, step.nodeId)?.setAvailableUpstreamNamespaces?.(
      props.modelValue.slice(0, index).map((previous) => previous.outputNamespace),
    );
  });
};

// Hidrata los stores de nodo con lo que ya traiga la secuencia (edicion de una
// plantilla existente) y mantiene al dia el contrato aguas arriba.
watch(
  () => props.modelValue,
  (steps) => {
    steps.forEach((step) => {
      resolveNodeStore(step.nodeType, step.nodeId)?.hydrateFromNode({
        outputNamespace: step.outputNamespace,
        params: step.params,
      });
    });

    syncUpstreamNamespaces();
  },
  { immediate: true, deep: true },
);

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
      <q-expansion-item
        v-for="(step, index) in props.modelValue"
        :key="step.nodeId"
        class="pd-sequence-item"
        expand-separator
        @show="syncFromNodeStore(step)"
        @hide="syncFromNodeStore(step)"
      >
        <template #header>
          <q-item-section avatar>
            <q-badge class="pd-badge">{{ index + 1 }}</q-badge>
          </q-item-section>

          <q-item-section>
            <q-item-label class="pd-mono">{{ step.nodeId }}</q-item-label>
            <q-item-label caption class="pd-mono pd-sequence-namespace">
              {{ step.outputNamespace }}
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
                :disable="index === 0"
                :aria-label="`Subir ${step.nodeId}`"
                @click.stop="moveNode(index, -1)"
              />
              <q-btn
                class="pd-btn-icon"
                outline
                dense
                size="sm"
                icon="arrow_downward"
                :disable="index === props.modelValue.length - 1"
                :aria-label="`Bajar ${step.nodeId}`"
                @click.stop="moveNode(index, 1)"
              />
              <q-btn
                class="pd-btn-icon pd-btn-icon--danger"
                outline
                dense
                size="sm"
                icon="close"
                :aria-label="`Quitar ${step.nodeId}`"
                @click.stop="removeNode(index)"
              />
            </div>
          </q-item-section>
        </template>

        <div class="pd-sequence-body q-pa-md">
          <label class="pd-label" :for="`namespace-${step.nodeId}`">
            Namespace de salida<span class="pd-required">*</span>
          </label>
          <q-input
            :id="`namespace-${step.nodeId}`"
            :model-value="step.outputNamespace"
            outlined
            dense
            class="q-mt-xs q-mb-md pd-mono"
            maxlength="50"
            :rules="[
              (val: string) => /^[a-z0-9_]+$/.test(val) || 'Solo minusculas, digitos y guion bajo',
            ]"
            @update:model-value="updateNamespace(index, String($event ?? ''))"
          />

          <!-- Resolucion polimorfica (§3.1): el tipo elige el componente, sin un
               solo v-if por nodeType. Los tipos aun sin configurador caen al
               editor JSON del else. -->
          <component
            :is="configComponentFor(step.nodeType)"
            v-if="configComponentFor(step.nodeType)"
            :node-id="step.nodeId"
            @update:model-value="syncFromNodeStore(step)"
          />

          <div v-else class="pd-sequence-json">
            <div class="row items-center justify-between q-mb-xs">
              <span class="pd-label">Parametros (JSON)</span>
              <span v-if="paramsErrorFor(step.nodeId)" class="pd-mono pd-sequence-error">
                {{ paramsErrorFor(step.nodeId) }}
              </span>
            </div>
            <p class="pd-subtitle q-mt-none q-mb-sm">
              Este tipo de nodo todavia no tiene formulario dedicado; sus `params` se editan
              directamente.
            </p>
            <JsonPipelinePreview
              :model-value="paramsTextFor(step)"
              :readonly="false"
              @update:model-value="onParamsTextChange(step.nodeId, $event)"
            />
          </div>
        </div>
      </q-expansion-item>
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

:deep(.q-field--outlined .q-field__control) {
  background: var(--pd-card-bg);

  &::before {
    border-color: var(--pd-border);
  }
}
</style>
