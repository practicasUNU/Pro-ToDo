<script setup lang="ts">
import { computed } from 'vue';

import { nodeBaseParamsRegistry } from '@components/nodes/node-base-params-registry';

import { NODE_OUTPUT_NAMESPACES, NodeType } from '@/types/pipeline';
import { actionsForNodeType, ERROR_BRANCH_ACTIONS } from '@/types/nodes/error-branch.types';

import type { AssemblerStep } from '@/utils/pipeline-assembler';
import type { ErrorBranchAction } from '@/types/nodes/error-branch.types';

interface Props {
  /** Paso que este bloque representa. */
  step: AssemblerStep;
  /** Posicion 1..n, solo para la insignia de la cabecera. */
  position: number;
  isFirst: boolean;
  isLast: boolean;
  /** Accion de contingencia declarada por el paso, o `null` si no tiene. */
  errorBranch: ErrorBranchAction | null;
  /**
   * Si la topologia tiene un `PROCESADOR_IA` al que desviar.
   *
   * Llega como prop y no se deduce aqui: la ficha solo conoce SU paso, y el
   * fallback de vision depende del grafo entero.
   */
  canOfferVision: boolean;
  /**
   * La topologia impone los `params` base de este nodo.
   *
   * Llega como prop y no se deduce aqui: depende de que otro paso del flujo haya
   * declarado una ruta de contingencia, y la ficha solo conoce el suyo.
   */
  baseParamsLocked: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  /** Desplazamiento relativo: -1 sube, +1 baja. */
  move: [offset: number];
  remove: [];
  'update:namespace': [value: string];
  'update:params': [params: Record<string, unknown>];
  'update:errorBranch': [action: ErrorBranchAction | null];
}>();

const NO_VISION_HINT =
  'Para reintentar con vision IA, la topologia tiene que incluir un nodo Procesador IA: la ruta apunta al que ya exista, no crea uno nuevo.';

/**
 * Un nodo de alerta no puede declarar contingencia: se desviaria a si mismo.
 */
const supportsErrorBranch = computed<boolean>(() => props.step.nodeType !== NodeType.DESTINO_SMTP);

const hasErrorBranch = computed<boolean>(() => props.errorBranch !== null);

/**
 * Acciones que ESTE paso puede ofrecer (selector cerrado, `frontend-quasar.md` §4).
 *
 * La vision solo aparece en el parser y solo si hay un Procesador IA al que
 * apuntar: ofrecerla en otro tipo crearia una rama muerta que ninguna regla del
 * backend detecta, porque el codigo que la dispara solo lo emite el parser.
 */
const actionOptions = computed(() =>
  actionsForNodeType(props.step.nodeType)
    // El catalogo ya acota por tipo; aqui solo queda la condicion que depende
    // del GRAFO: sin un Procesador IA al que apuntar no hay vision que ofrecer.
    .filter((action) => action !== 'VISION_IA' || props.canOfferVision)
    .map((action) => ({
      label: ERROR_BRANCH_ACTIONS[action].label,
      value: action,
      description: ERROR_BRANCH_ACTIONS[action].hint,
    })),
);

/** Al activar se cae a la alerta, que siempre es una accion valida. */
const onToggleErrorBranch = (enabled: boolean): void => {
  emit('update:errorBranch', enabled ? 'ALERTA_SMTP' : null);
};

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
        :locked="props.baseParamsLocked"
        @update:params="emit('update:params', $event)"
      />

      <!-- Ruta de contingencia. Vive AQUI y no en el asistente: `onErrorStep` es
           topologia, y la plantilla es su unica autoridad. El asistente solo la
           lee y pide los parametros de operacion del nodo que la atiende. -->
      <div v-if="supportsErrorBranch" class="pd-branch-block q-mt-md q-pa-sm">
        <q-toggle
          :model-value="hasErrorBranch"
          dense
          class="pd-branch-toggle"
          label="Habilitar ruta de contingencia (onErrorStep)"
          :data-test="`error-branch-toggle-${props.step.nodeId}`"
          @update:model-value="onToggleErrorBranch(Boolean($event))"
        />

        <p class="pd-subtitle q-mt-xs q-mb-none">
          Sin ruta declarada, un fallo de este paso detiene el flujo y lo deja en PAUSADO. Con ella,
          el motor salta al nodo indicado y le entrega que fallo, con que codigo y el payload
          parcial.
        </p>

        <!-- Selector CERRADO (Poka-Yoke §4): sin entrada de texto libre, solo
             las acciones del catalogo que el motor sabe atender.

             La marca `data-test` va en el CONTENEDOR y no en el propio
             `q-select`: Quasar derrama los atributos sobre un div interno, asi
             que marcarlo a el no sirve para localizar el componente. -->
        <div v-if="hasErrorBranch" :data-test="`error-branch-action-${props.step.nodeId}`">
          <q-select
            :id="`error-branch-${props.step.nodeId}`"
            :model-value="props.errorBranch"
            :options="actionOptions"
            outlined
            dense
            emit-value
            map-options
            class="q-mt-sm"
            label="Que hacer al fallar este paso"
            @update:model-value="emit('update:errorBranch', $event as ErrorBranchAction)"
          >
            <template #option="scope">
              <q-item v-bind="scope.itemProps">
                <q-item-section>
                  <q-item-label>{{ scope.opt.label }}</q-item-label>
                  <q-item-label caption class="pd-subtitle">{{
                    scope.opt.description
                  }}</q-item-label>
                </q-item-section>
              </q-item>
            </template>
          </q-select>
        </div>

        <!-- La vision no se puede ofrecer sin un nodo de IA al que apuntar: uno
             nuevo chocaria con el del flujo en el namespace `llm_response`. -->
        <p
          v-if="
            hasErrorBranch &&
            props.step.nodeType === NodeType.PARSER_PRE_IA &&
            !props.canOfferVision
          "
          class="pd-subtitle q-mt-sm q-mb-none"
          :data-test="`no-vision-hint-${props.step.nodeId}`"
        >
          {{ NO_VISION_HINT }}
        </p>
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

// Franja de acento a la izquierda: se lee como una derivacion del paso y no
// como otro campo obligatorio mas. El color sale del token, nunca de un hex.
.pd-branch-block {
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-border);
  border-left: 3px solid var(--pd-warning);
  border-radius: $generic-border-radius;
}

.pd-branch-toggle {
  color: var(--pd-text-primary);
}

// El campo del namespace vive ahora aqui, asi que su fondo tambien.
:deep(.q-field--outlined .q-field__control) {
  background: var(--pd-card-bg);

  &::before {
    border-color: var(--pd-border);
  }
}
</style>
