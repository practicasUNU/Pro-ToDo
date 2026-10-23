<script setup lang="ts">
import { computed, watch } from 'vue';
import { copyToClipboard, useQuasar } from 'quasar';

import { useLogsStore } from '@stores/logs.store';

import { extractApiErrorMessage } from '@/utils/api-error';
import { formatDateTime } from '@/utils/date-format';

/**
 * Consola de solo lectura con la traza de una ejecucion.
 *
 * Se abre desde las filas con fallo, pausa o alertas (`canInspectLog`). Al
 * abrirse pide la traza al store; no guarda estado propio salvo la apertura.
 *
 * Copia con `copyToClipboard` de Quasar y no con `navigator.clipboard`: este
 * ultimo no existe fuera de un contexto seguro, y el panel se sirve por HTTP
 * dentro de la red corporativa.
 */
const props = defineProps<{
  modelValue: boolean;
  /** Ejecucion a inspeccionar; `null` mientras no hay ninguna elegida. */
  executionId: string | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

const $q = useQuasar();
const logsStore = useLogsStore();

/** Clase del badge por severidad: el texto acompana siempre al color. */
const LEVEL_BADGES: Record<string, string> = {
  URGENTE: 'pd-badge--failed',
  GRAVE: 'pd-badge--paused',
};

const log = computed(() => logsStore.currentLog);

const levelBadgeClass = computed(() =>
  log.value?.level ? (LEVEL_BADGES[log.value.level] ?? 'pd-badge--inactive') : '',
);

/** Lo que se copia: la traza y, debajo, las entradas completas. */
const clipboardText = computed(() =>
  [log.value?.stackTrace, log.value?.rawLog].filter((part) => !!part).join('\n\n'),
);

const load = async (executionId: string): Promise<void> => {
  try {
    await logsStore.loadExecutionLog(executionId);
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo cargar la traza de la ejecución.'),
    });
  }
};

watch(
  () => [props.modelValue, props.executionId] as const,
  ([isOpen, executionId]) => {
    if (isOpen && executionId !== null) {
      void load(executionId);
    }
  },
  { immediate: true },
);

const close = (): void => {
  emit('update:modelValue', false);
};

const onDialogToggle = (value: boolean): void => {
  emit('update:modelValue', value);

  if (!value) {
    logsStore.clear();
  }
};

const copyLog = async (): Promise<void> => {
  try {
    await copyToClipboard(clipboardText.value);
    $q.notify({ type: 'positive', message: 'Traza copiada al portapapeles.', timeout: 2000 });
  } catch {
    $q.notify({ type: 'negative', message: 'No se pudo copiar la traza.' });
  }
};
</script>

<template>
  <q-dialog :model-value="modelValue" @update:model-value="onDialogToggle">
    <q-card class="pd-dialog-card pd-log-viewer" data-test="log-viewer">
      <q-card-section class="row items-center no-wrap q-gutter-sm">
        <span class="pd-icon-circle">
          <q-icon name="terminal" size="20px" class="pd-log-viewer__icon" aria-hidden="true" />
        </span>
        <div class="col">
          <div class="pd-h2">Traza de la ejecución</div>
          <div v-if="executionId" class="pd-mono pd-text-secondary">{{ executionId }}</div>
        </div>
      </q-card-section>

      <q-card-section class="q-pt-none">
        <div v-if="logsStore.isLoading" class="pd-log-viewer__loading" role="status">
          <q-spinner size="24px" />
          <span>Leyendo los ficheros de traza…</span>
        </div>

        <template v-else-if="log">
          <div class="pd-log-viewer__meta">
            <q-badge
              v-if="log.level"
              class="pd-badge"
              :class="levelBadgeClass"
              data-test="log-level"
            >
              {{ log.level }}
            </q-badge>
            <span v-if="log.timestamp" class="pd-text-secondary">
              Último fallo:
              <time :datetime="log.timestamp">{{ formatDateTime(log.timestamp) }}</time>
            </span>
          </div>

          <h3 class="pd-label pd-log-viewer__heading">Stack trace</h3>
          <pre v-if="log.stackTrace" class="pd-mono pd-terminal" data-test="log-stack">{{
            log.stackTrace
          }}</pre>
          <p v-else class="pd-text-secondary" data-test="log-no-stack">
            La ejecución no registró ningún fallo.
          </p>

          <h3 class="pd-label pd-log-viewer__heading">Registro del servidor</h3>
          <pre v-if="log.rawLog" class="pd-mono pd-terminal" data-test="log-raw">{{
            log.rawLog
          }}</pre>
          <p v-else class="pd-text-secondary" data-test="log-no-raw">
            No quedan entradas en los ficheros de traza: se conservan 14 días.
          </p>
          <p v-if="log.truncated" class="pd-text-secondary" data-test="log-truncated">
            Se muestran solo las entradas más recientes.
          </p>
        </template>
      </q-card-section>

      <q-card-actions align="right" class="q-px-md q-pb-md">
        <!-- Cerrar es la accion de escape: secundaria, nunca compite con la
             principal del dialogo (frontend-quasar.md §2). -->
        <q-btn
          flat
          no-caps
          label="Cerrar"
          class="pd-btn-secondary"
          data-test="log-close"
          @click="close"
        />
        <q-btn
          unelevated
          no-caps
          icon="content_copy"
          label="Copiar al portapapeles"
          class="pd-btn-primary"
          :disable="!clipboardText"
          data-test="log-copy"
          @click="copyLog"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<style scoped lang="scss">
.pd-log-viewer {
  width: 820px;
}

.pd-log-viewer__icon {
  color: var(--pd-primary);
}

.pd-log-viewer__loading,
.pd-log-viewer__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.pd-log-viewer__heading {
  margin: 16px 0 6px;
}
</style>
