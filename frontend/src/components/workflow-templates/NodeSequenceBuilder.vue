<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useQuasar } from 'quasar';

import { useNodeCatalogStore } from '@stores/node-catalog.store';
import TemplateNodeCard from '@components/workflow-templates/TemplateNodeCard.vue';

import { useSelectFilter } from '@/composables/useSelectFilter';

import { extractApiErrorMessage } from '@/utils/api-error';

import { NODE_CATEGORY_LABELS, NodeCategory } from '@/types/node-catalog';
import { withBaseParamDefaults } from '@/utils/node-base-params';

import { DEFAULT_OUTPUT_NAMESPACE_BY_NODE_TYPE, TRIGGER_NODE_TYPES } from '@/types/pipeline';

import type { AssemblerStep } from '@/utils/pipeline-assembler';
import type { NodeCatalogEntry } from '@/types/node-catalog';
import type { NodeType } from '@/types/pipeline';
import type { ErrorBranchAction } from '@/types/nodes/error-branch.types';

interface Props {
  /** Secuencia actual, en orden de ejecucion. */
  modelValue: readonly AssemblerStep[];
  /**
   * Accion de contingencia por `nodeId`, resuelta por el anfitrion.
   *
   * Llega RESUELTA en vez de importar el store aqui: este componente ya recibe
   * la secuencia por prop, y leer la mitad del estado por una via y la otra
   * mitad por otra abriria la puerta a que discrepasen.
   */
  errorBranches: Readonly<Record<string, ErrorBranchAction | null>>;
  /**
   * Si alguna ruta de contingencia impone los `params` base de los pasos.
   *
   * Es una propiedad del GRAFO y no de un paso: la ruta de vision la declara el
   * parser, pero quien queda atado es el disparador que ingiere los adjuntos.
   */
  baseParamsLocked: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:modelValue': [value: AssemblerStep[]];
  'update:params': [nodeId: string, params: Record<string, unknown>];
  'update:errorBranch': [nodeId: string, action: ErrorBranchAction | null];
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
/**
 * Mensaje unico de la regla del Entry Point.
 *
 * Replica literalmente el de la regla 9 del validador del backend, que es la
 * autoridad: la UI solo se adelanta para no gastar un 400 seguro.
 */
const ENTRY_POINT_MESSAGE =
  'El nodo inicial (Entry Point) debe ser un disparador de categoria TRIGGER';

/** La primera posicion es el Entry Point y solo admite disparadores. */
const isEntryPointSlot = computed<boolean>(() => props.modelValue.length === 0);

/**
 * Un paso ya en la secuencia es disparador.
 *
 * Pregunta al enum y no al catalogo: `findByCode` devuelve `undefined` mientras
 * `GET /api/nodos` esta en vuelo, y eso convertiria un disparador legitimo en un
 * movimiento rechazado por una carrera de arranque.
 */
const isTriggerStep = (step: AssemblerStep): boolean => TRIGGER_NODE_TYPES.has(step.nodeType);

const groupedOptions = computed(() =>
  catalogStore.entries
    // Poka-Yoke: con la secuencia vacia lo que se anade ES el punto de entrada,
    // asi que los demas ni se ofrecen. Se FILTRA en vez de deshabilitar, al
    // contrario que `implemented`: un nodo sin estrategia es una limitacion
    // temporal que conviene ver; un destino en la posicion 0 no es una opcion
    // futura, es un error de concepto.
    .filter((entry) => !isEntryPointSlot.value || entry.category === NodeCategory.TRIGGER)
    .map((entry) => ({
      entry,
      label: entry.name,
      category: NODE_CATEGORY_LABELS[entry.category],
      // Es `string | null` en el contrato del catalogo, asi que se propaga tal
      // cual y es la plantilla quien decide si hay linea que pintar.
      description: entry.description,
      disable: !entry.implemented,
    })),
);

// Filtrado predictivo sobre el catalogo de nodos. Busca por el nombre visible
// y tambien por el codigo, que es como lo recuerda quien ya conoce el sistema.
const { filteredOptions: filteredNodeOptions, filterFn: filterNodes } =
  useSelectFilter(groupedOptions);

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

/**
 * Rechaza una secuencia que dejaria un no-disparador abriendo el flujo.
 *
 * Se comprueba sobre el RESULTADO y no sobre la operacion: mover, subir y
 * eliminar pueden desalojar al disparador de la posicion 0 de tres formas
 * distintas, y juzgarlas por separado dejaria un hueco en cuanto se anada una
 * cuarta.
 */
const rejectsEntryPoint = (steps: readonly AssemblerStep[]): boolean => {
  const [first] = steps;

  // La secuencia vacia es legitima: se esta desmontando la plantilla entera.
  if (first === undefined) return false;

  if (isTriggerStep(first)) return false;

  $q.notify({ type: 'warning', message: ENTRY_POINT_MESSAGE });

  return true;
};

const removeNode = (index: number): void => {
  const steps = props.modelValue.filter((_, current) => current !== index);

  if (rejectsEntryPoint(steps)) return;

  emitSequence(steps);
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

  if (rejectsEntryPoint(steps)) return;

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
        use-input
        fill-input
        hide-selected
        input-debounce="0"
        :options="filteredNodeOptions"
        @filter="filterNodes"
        :loading="catalogStore.isLoading"
        :label="isEntryPointSlot ? 'Elige el disparador inicial' : 'Anadir nodo'"
        :hint="
          isEntryPointSlot
            ? 'Solo se ofrecen disparadores: son los unicos que pueden abrir un flujo.'
            : ''
        "
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
        :error-branch="props.errorBranches[step.nodeId] ?? null"
        :base-params-locked="props.baseParamsLocked"
        @update:namespace="updateNamespace(index, $event)"
        @update:params="emit('update:params', step.nodeId, $event)"
        @update:error-branch="emit('update:errorBranch', step.nodeId, $event)"
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
