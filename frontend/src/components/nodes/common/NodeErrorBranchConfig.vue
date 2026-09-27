<script setup lang="ts">
import { computed } from 'vue';

import { useFlujoDraftStore } from '@stores/flujo-draft.store';

import SmtpAlertConfig from '@components/nodes/SmtpAlertConfig.vue';

import type { NodeType } from '@/types/pipeline';
import {
  ERROR_BRANCH_ACTIONS,
  ERROR_BRANCH_TRIGGERS,
  SHARED_ALERT_NODE_ID,
  triggersForNodeType,
} from '@/types/nodes/error-branch.types';

import type { ErrorBranchAction, ErrorBranchTrigger } from '@/types/nodes/error-branch.types';

interface Props {
  /** Identificador del nodo que se desviaria (contrato uniforme §3.1). */
  nodeId: string;
  nodeType: NodeType;
}

const props = defineProps<Props>();

// La ruta es propiedad de la TOPOLOGIA, no del nodo, asi que vive en el
// agregador y no en el store del paso: es el unico que conoce el grafo entero y
// puede resolver a que nodo desviarse.
const draftStore = useFlujoDraftStore();

const PANEL_HINT =
  'Sin ruta declarada, un fallo de este paso detiene el flujo y lo deja en PAUSADO a la espera de que alguien lo mire. Con ella, el motor salta al nodo indicado y le entrega que fallo, con que codigo y el payload parcial.';

const PROVISION_HINT =
  'Se creara un unico nodo de alerta para todo el flujo. Todas las rutas que declares apuntaran a el, y la carta ya dice cual de los pasos ha fallado.';

const NO_VISION_HINT =
  'Para reintentar con vision IA, el flujo tiene que incluir un nodo Procesador IA: la ruta apunta al que ya exista, no crea uno nuevo.';

const branch = computed(() => draftStore.errorBranches[props.nodeId] ?? null);

const isEnabled = computed<boolean>(() => branch.value !== null);

/** Disparadores que este tipo de nodo puede ofrecer (selector cerrado, §4). */
const triggerOptions = computed(() =>
  triggersForNodeType(props.nodeType).map((trigger) => ({
    label: ERROR_BRANCH_TRIGGERS[trigger].label,
    value: trigger,
    description: ERROR_BRANCH_TRIGGERS[trigger].hint,
  })),
);

/**
 * Acciones disponibles, acotadas por la topologia del flujo.
 *
 * La vision solo aparece si el flujo tiene un Procesador IA al que apuntar Y si
 * el disparador es el fallo por medios sin texto: es el unico caso en el que un
 * modelo con vision aporta algo, porque el correo trae una imagen o un PDF
 * escaneado en vez de texto.
 */
const actionOptions = computed(() =>
  draftStore.availableBranchActions
    .filter((action) => action !== 'VISION_IA' || branch.value?.trigger === 'SIN_TEXTO_EXTRAIBLE')
    .map((action) => ({
      label: ERROR_BRANCH_ACTIONS[action].label,
      value: action,
      description: ERROR_BRANCH_ACTIONS[action].hint,
    })),
);

const showsAlertConfig = computed<boolean>(
  () => branch.value?.action === 'ALERTA_SMTP' && draftStore.needsProvisionedAlertNode,
);

/** Nodo al que el motor saltaria de verdad, para no dejarlo implicito. */
const resolvedTarget = computed<string | null>(() =>
  branch.value === null ? null : draftStore.resolveBranchTarget(branch.value.action),
);

const onToggle = (enabled: boolean): void => {
  draftStore.setErrorBranch(
    props.nodeId,
    enabled ? { trigger: 'CUALQUIER_FALLO', action: 'ALERTA_SMTP' } : null,
  );
};

/**
 * Cambiar el disparador puede invalidar la accion elegida.
 *
 * Pasar de "sin texto extraible" a "cualquier fallo" con la vision seleccionada
 * dejaria una ruta que apunta al nodo de IA ante un fallo de configuracion, que
 * no es lo que nadie quiso decir. Se cae a la alerta, que siempre es valida.
 */
const onTriggerChange = (trigger: ErrorBranchTrigger): void => {
  const current = branch.value;

  if (current === null) return;

  const action: ErrorBranchAction =
    current.action === 'VISION_IA' && trigger !== 'SIN_TEXTO_EXTRAIBLE'
      ? 'ALERTA_SMTP'
      : current.action;

  draftStore.setErrorBranch(props.nodeId, { trigger, action });
};

const onActionChange = (action: ErrorBranchAction): void => {
  const current = branch.value;

  if (current === null) return;

  draftStore.setErrorBranch(props.nodeId, { trigger: current.trigger, action });
};
</script>

<template>
  <q-expansion-item
    class="pd-card pd-branch-panel q-mt-md"
    :data-node-id="nodeId"
    data-test="error-branch-panel"
    :default-opened="isEnabled"
  >
    <template #header>
      <q-item-section avatar>
        <q-icon name="warning" size="22px" class="pd-branch-icon" />
      </q-item-section>
      <q-item-section>
        <div class="pd-label">Ruta de Contingencia ante Fallos (onErrorStep)</div>
        <div class="pd-subtitle">
          {{ isEnabled ? 'Activa' : 'Sin declarar: un fallo detiene el flujo' }}
        </div>
      </q-item-section>
    </template>

    <div class="q-pa-md">
      <p class="pd-subtitle q-mb-md">{{ PANEL_HINT }}</p>

      <q-toggle
        :model-value="isEnabled"
        color="primary"
        label="Activar desvio alternativo al fallar este paso"
        data-test="error-branch-toggle"
        @update:model-value="onToggle(Boolean($event))"
      />

      <template v-if="isEnabled && branch">
        <div class="q-mt-md" data-test="error-branch-trigger">
          <label class="pd-label" for="error-branch-trigger-select">Cuando desviar</label>
          <q-select
            id="error-branch-trigger-select"
            :model-value="branch.trigger"
            :options="triggerOptions"
            outlined
            dense
            emit-value
            map-options
            class="q-mt-xs"
            @update:model-value="onTriggerChange($event as ErrorBranchTrigger)"
          >
            <template #option="scope">
              <q-item v-bind="scope.itemProps">
                <q-item-section>
                  <q-item-label>{{ scope.opt.label }}</q-item-label>
                  <q-item-label caption>{{ scope.opt.description }}</q-item-label>
                </q-item-section>
              </q-item>
            </template>
          </q-select>
        </div>

        <div class="q-mt-md" data-test="error-branch-action">
          <label class="pd-label" for="error-branch-action-select">Que hacer entonces</label>
          <q-select
            id="error-branch-action-select"
            :model-value="branch.action"
            :options="actionOptions"
            outlined
            dense
            emit-value
            map-options
            class="q-mt-xs"
            :hint="resolvedTarget ? `El motor saltara al nodo ${resolvedTarget}` : ''"
            @update:model-value="onActionChange($event as ErrorBranchAction)"
          >
            <template #option="scope">
              <q-item v-bind="scope.itemProps">
                <q-item-section>
                  <q-item-label>{{ scope.opt.label }}</q-item-label>
                  <q-item-label caption>{{ scope.opt.description }}</q-item-label>
                </q-item-section>
              </q-item>
            </template>
          </q-select>
        </div>

        <!-- La vision no se puede ofrecer sin un nodo de IA al que apuntar: uno
             satelite chocaria con el del flujo en el namespace llm_response. -->
        <q-banner
          v-if="branch.trigger === 'SIN_TEXTO_EXTRAIBLE' && actionOptions.length === 1"
          dense
          class="pd-info-banner q-mt-md"
          data-test="no-vision-hint"
        >
          <template #avatar>
            <q-icon name="info_outline" size="20px" class="pd-branch-hint-icon" />
          </template>
          {{ NO_VISION_HINT }}
        </q-banner>

        <template v-if="showsAlertConfig">
          <q-banner dense class="pd-info-banner q-mt-md">
            <template #avatar>
              <q-icon name="alternate_email" size="20px" class="pd-branch-hint-icon" />
            </template>
            {{ PROVISION_HINT }}
          </q-banner>

          <!-- El configurador del nodo de alerta, incrustado: el operador
               declara la ruta y la parametriza en el mismo paso, sin tener que
               buscar otro sitio donde poner los destinatarios. -->
          <div class="q-mt-md" data-test="embedded-alert-config">
            <SmtpAlertConfig :node-id="SHARED_ALERT_NODE_ID" />
          </div>
        </template>
      </template>
    </div>
  </q-expansion-item>
</template>

<style scoped lang="scss">
// Borde sutil y no acento fuerte: es una seccion OPCIONAL, y destacarla como si
// faltara algo empujaria a declarar rutas que el flujo no necesita.
.pd-branch-panel {
  border: 1px solid var(--pd-border);
}

.pd-branch-icon {
  color: var(--pd-warning);
}

.pd-branch-hint-icon {
  color: var(--pd-primary);
}

.pd-info-banner {
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-border);
  border-radius: $generic-border-radius;
  color: var(--pd-text-primary);
}

:deep(.q-field--outlined .q-field__control) {
  background: var(--pd-card-bg);
}

:deep(.q-field--outlined .q-field__control::before) {
  border-color: var(--pd-border);
}

:deep(.q-field__messages) {
  color: var(--pd-text-secondary);
}
</style>
