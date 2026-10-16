<script setup lang="ts">
import { computed } from 'vue';

import { usePauseFlowStore } from '@stores/nodes/pause-flow.store';
import { isEmailAddress } from '@/utils/email-address';
import { NODE_TYPE_LABELS, NodeType } from '@/types/pipeline';
import {
  MAX_PAUSE_DELAY_SECONDS,
  MAX_PAUSE_MESSAGE_LENGTH,
  PauseTriggerMode,
} from '@/types/nodes/pause-flow.types';

interface Props {
  nodeId: string;
}

const props = defineProps<Props>();

const store = usePauseFlowStore(props.nodeId);

/** Opciones del conmutador. Lista cerrada: son los dos unicos modos. */
const MODE_OPTIONS = [
  { label: 'Pausa inmediata', value: PauseTriggerMode.IMMEDIATE },
  { label: 'Pausa con retardo', value: PauseTriggerMode.DELAYED },
] as const;

const DELAY_HINT = `Entre 1 y ${MAX_PAUSE_DELAY_SECONDS} segundos (${MAX_PAUSE_DELAY_SECONDS / 60} minutos)`;

const RECIPIENT_HINT = 'Quien debe enterarse de que el flujo quedo a la espera';

/**
 * Aviso de que nadie reanuda solo.
 *
 * Es la informacion que mas falta hace en este formulario: el nombre "pausa
 * programada" invita a pensar que el flujo volvera por su cuenta, y no lo hace
 * ni lo hara. El retardo decide CUANDO se congela, no cuando se despierta.
 */
const RESUME_NOTICE =
  'El flujo quedara detenido hasta que una persona lo reanude desde la tabla de flujos o desde el canvas. No se reanuda solo.';

/** Equivalencia en minutos del retardo, para no obligar a dividir mentalmente. */
const delayInMinutes = computed<string>(() =>
  (store.config.delaySeconds / 60).toFixed(1).replace('.0', ''),
);

/** Clase del campo de retardo segun si el valor cabe en el tope del backend. */
const delayFieldClass = computed<string>(() => {
  if (store.config.delaySeconds < 1) return '';

  return store.isDelayOutOfRange ? 'pd-field--out-of-range' : 'pd-field--in-range';
});
</script>

<template>
  <section class="pd-card q-pa-md" :data-node-id="nodeId">
    <header class="row items-center no-wrap q-gutter-sm q-mb-md">
      <span class="pd-icon-circle">
        <q-icon name="pause_circle" size="20px" class="pd-node-icon" />
      </span>
      <div>
        <div class="pd-h2">{{ NODE_TYPE_LABELS[NodeType.PAUSA_FLOW] }}</div>
        <div class="pd-subtitle">
          Detiene el flujo a proposito y lo deja reanudable. Util cuando el pipeline debe esperar
          una revision humana antes de continuar.
        </div>
      </div>
    </header>

    <div class="q-mb-md">
      <span class="pd-label">Cuando congelar el flujo</span>
      <div class="q-mt-xs">
        <q-btn-toggle
          :model-value="store.config.pauseMode"
          no-caps
          unelevated
          toggle-color="primary"
          :options="[...MODE_OPTIONS]"
          data-test="pause-mode"
          @update:model-value="store.setPauseMode($event as PauseTriggerMode)"
        />
      </div>
    </div>

    <!-- El retardo solo existe en el modo diferido: mostrarlo siempre invitaria
         a rellenar un campo que no se publica. -->
    <div v-if="store.isDelayed" class="row q-col-gutter-md items-start q-mb-md">
      <div class="col-12 col-md-6" data-test="delay-field">
        <label class="pd-label" for="pause-flow-delay">
          Segundos de espera<span class="pd-required">*</span>
        </label>
        <q-input
          id="pause-flow-delay"
          :model-value="store.config.delaySeconds"
          type="number"
          outlined
          dense
          class="q-mt-xs"
          :class="delayFieldClass"
          :min="1"
          :max="MAX_PAUSE_DELAY_SECONDS"
          :hint="DELAY_HINT"
          :rules="[
            (val: number) => val >= 1 || 'El retardo debe ser de al menos 1 segundo',
            (val: number) =>
              val <= MAX_PAUSE_DELAY_SECONDS ||
              `El retardo no puede superar ${MAX_PAUSE_DELAY_SECONDS} segundos`,
          ]"
          @update:model-value="store.updateConfig({ delaySeconds: Number($event) })"
        />
        <div
          v-if="store.config.delaySeconds > 0"
          class="pd-mono pd-delay-echo q-mt-xs"
          data-test="delay-echo"
        >
          Equivale a {{ delayInMinutes }} min de espera antes de congelar.
        </div>
      </div>
    </div>

    <!-- Lo unico que el operador no puede deducir del formulario. Va con
         `role="note"` y no como banner de alerta: no hay nada mal configurado,
         es el funcionamiento normal del nodo. -->
    <q-banner dense class="pd-info-banner q-mb-md" data-test="resume-notice">
      <template #avatar>
        <q-icon name="info" size="20px" class="pd-node-icon" />
      </template>
      {{ RESUME_NOTICE }}
    </q-banner>

    <div class="q-mb-md">
      <q-toggle
        :model-value="store.config.notifyOnPause"
        label="Notificar la pausa por correo"
        data-test="notify-toggle"
        @update:model-value="store.updateConfig({ notifyOnPause: $event })"
      />
    </div>

    <div v-if="store.config.notifyOnPause" class="row q-col-gutter-md items-start q-mb-md">
      <div class="col-12 col-md-6" data-test="recipient-field">
        <label class="pd-label" for="pause-flow-recipient">
          Destinatario del aviso<span class="pd-required">*</span>
        </label>
        <q-input
          id="pause-flow-recipient"
          :model-value="store.config.notificationRecipient"
          outlined
          dense
          type="email"
          class="q-mt-xs"
          :hint="RECIPIENT_HINT"
          :rules="[
            (val: string) => val.trim().length > 0 || 'Indica a quien avisar',
            (val: string) => isEmailAddress(val.trim()) || 'No parece una direccion de correo',
          ]"
          @update:model-value="store.updateConfig({ notificationRecipient: String($event) })"
        />
      </div>
    </div>

    <div class="row q-col-gutter-md items-start">
      <div class="col-12 col-md-8" data-test="message-field">
        <label class="pd-label" for="pause-flow-message">Motivo de la pausa</label>
        <q-input
          id="pause-flow-message"
          :model-value="store.config.customPauseMessage"
          outlined
          dense
          type="textarea"
          autogrow
          class="q-mt-xs"
          :maxlength="MAX_PAUSE_MESSAGE_LENGTH"
          counter
          hint="Texto plano. Se guarda en la trazabilidad y acompana al aviso por correo."
          @update:model-value="store.updateConfig({ customPauseMessage: String($event) })"
        />
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.pd-node-icon {
  color: var(--pd-primary);
}

.pd-info-banner {
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-border);
  border-radius: $generic-border-radius;
  color: var(--pd-text-primary);
}

.pd-delay-echo {
  color: var(--pd-text-secondary);
  font-size: 12px;
}
</style>
