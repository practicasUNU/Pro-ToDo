<script setup lang="ts">
import { computed } from 'vue';
import { useQuasar } from 'quasar';

import {
  MIN_POLL_INTERVAL_MS,
  PASSWORD_ENV_KEY_PATTERN,
  useTriggerImapStore,
} from '@stores/nodes/trigger-imap.store';

import { extractApiErrorMessage } from '@/utils/api-error';

interface Props {
  /** Identificador del nodo en el `pipeline_schema` (contrato uniforme §3.1). */
  nodeId: string;
}

defineProps<Props>();

const $q = useQuasar();
const store = useTriggerImapStore();

// Mensajes de regla como constantes: el mismo texto lo usan la regla del campo y
// la ayuda bajo el input, y duplicarlo los dejaria divergir.
const PASSWORD_ENV_KEY_HINT =
  'Solo se admiten variables con el formato IMAP_*PASSWORD. La contrasena vive en el .env del servidor: aqui se declara unicamente el NOMBRE de la variable.';

const POLL_INTERVAL_HINT = `El backend rechaza periodos por debajo de ${MIN_POLL_INTERVAL_MS / 1000} s para no exceder los limites de tasa del proveedor IMAP.`;

/** Estado del indicador de conexion, derivado del ultimo resultado del backend. */
const connectionBadge = computed<{ label: string; classes: string } | null>(() => {
  if (store.connectionVerified) {
    return { label: 'Conexion verificada', classes: 'pd-check-badge--ok' };
  }

  if (store.lastCheckResult?.success === false) {
    return { label: 'Conexion fallida', classes: 'pd-check-badge--fail' };
  }

  return null;
});

/**
 * Prueba las credenciales y traduce el resultado a una notificacion.
 *
 * El store no captura el error a proposito (`frontend-architecture.md` §2.1):
 * decidir el mensaje es competencia de la vista. Se distinguen dos fallos
 * distintos: el que el servidor de correo diagnostica (llega como 200 con
 * `success: false`) y el que rompe la llamada al backend (excepcion).
 */
const onTestConnection = async (): Promise<void> => {
  try {
    const result = await store.testConnection();

    if (result.success) {
      $q.notify({
        type: 'positive',
        message: result.message ?? 'Conexion exitosa',
      });
      return;
    }

    $q.notify({
      type: 'negative',
      message: `[${result.error?.level ?? 'GRAVE'}] ${
        result.error?.message ?? 'No se pudo conectar con el buzon'
      }`,
    });
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo comprobar la conexion IMAP'),
    });
  }
};
</script>

<template>
  <section class="pd-card q-pa-md" :data-node-id="nodeId">
    <header class="row items-center no-wrap q-gutter-sm q-mb-md">
      <span class="pd-icon-circle">
        <q-icon name="mark_email_unread" size="20px" class="pd-node-icon" />
      </span>
      <div>
        <div class="pd-h2">Disparador IMAP</div>
        <div class="pd-subtitle">
          Lee el correo no leido mas reciente del buzon e inicia el flujo.
        </div>
      </div>
      <q-space />
      <q-badge v-if="connectionBadge" class="pd-badge" :class="connectionBadge.classes">
        {{ connectionBadge.label }}
      </q-badge>
    </header>

    <div class="row q-col-gutter-md">
      <div class="col-12 col-md-8">
        <label class="pd-label" for="imap-host">
          Servidor IMAP<span class="pd-required">*</span>
        </label>
        <q-input
          id="imap-host"
          :model-value="store.config.host"
          outlined
          dense
          class="q-mt-xs"
          placeholder="imap.unuware.com"
          :rules="[(val: string) => !!val?.trim() || 'El servidor es obligatorio']"
          @update:model-value="store.patchConfig({ host: String($event ?? '') })"
        />
      </div>

      <div class="col-12 col-md-4">
        <label class="pd-label" for="imap-port"> Puerto<span class="pd-required">*</span> </label>
        <q-input
          id="imap-port"
          :model-value="store.config.port"
          type="number"
          outlined
          dense
          class="q-mt-xs"
          :rules="[
            (val: number) => Number.isInteger(val) || 'El puerto debe ser un numero entero',
            (val: number) => (val > 0 && val <= 65535) || 'Puerto fuera de rango (1-65535)',
          ]"
          @update:model-value="store.patchConfig({ port: Number($event) })"
        />
      </div>

      <div class="col-12 col-md-8">
        <label class="pd-label" for="imap-user">
          Usuario del buzon<span class="pd-required">*</span>
        </label>
        <q-input
          id="imap-user"
          :model-value="store.config.user"
          outlined
          dense
          class="q-mt-xs"
          placeholder="notiweb@unuware.com"
          :rules="[(val: string) => !!val?.trim() || 'El usuario es obligatorio']"
          @update:model-value="store.patchConfig({ user: String($event ?? '') })"
        />
      </div>

      <div class="col-12 col-md-4">
        <label class="pd-label" for="imap-mailbox"> Buzon<span class="pd-required">*</span> </label>
        <q-input
          id="imap-mailbox"
          :model-value="store.config.mailbox"
          outlined
          dense
          class="q-mt-xs"
          :rules="[(val: string) => !!val?.trim() || 'El buzon es obligatorio']"
          @update:model-value="store.patchConfig({ mailbox: String($event ?? '') })"
        />
      </div>

      <div class="col-12">
        <label class="pd-label" for="imap-password-env-key">
          Variable de entorno con la contrasena<span class="pd-required">*</span>
        </label>
        <q-input
          id="imap-password-env-key"
          :model-value="store.config.passwordEnvKey"
          outlined
          dense
          class="q-mt-xs pd-mono"
          placeholder="IMAP_PASSWORD"
          :hint="PASSWORD_ENV_KEY_HINT"
          :rules="[
            (val: string) => !!val?.trim() || 'La variable es obligatoria',
            (val: string) => PASSWORD_ENV_KEY_PATTERN.test(val ?? '') || PASSWORD_ENV_KEY_HINT,
          ]"
          @update:model-value="store.patchConfig({ passwordEnvKey: String($event ?? '') })"
        />
      </div>

      <div class="col-12 col-md-6">
        <label class="pd-label" for="imap-poll-interval">
          Periodo de sondeo (ms)<span class="pd-required">*</span>
        </label>
        <q-input
          id="imap-poll-interval"
          :model-value="store.config.pollIntervalMs"
          type="number"
          outlined
          dense
          class="q-mt-xs"
          :hint="POLL_INTERVAL_HINT"
          :rules="[
            (val: number) =>
              (Number.isInteger(val) && val >= MIN_POLL_INTERVAL_MS) || POLL_INTERVAL_HINT,
          ]"
          @update:model-value="store.patchConfig({ pollIntervalMs: Number($event) })"
        />
      </div>

      <div class="col-12 col-md-6 flex items-center">
        <q-toggle
          :model-value="store.config.secure"
          color="primary"
          label="Conexion cifrada (TLS implicito)"
          @update:model-value="store.patchConfig({ secure: Boolean($event) })"
        />
      </div>
    </div>

    <!-- Poka-Yoke: el paso no se declara valido hasta que la conexion se prueba
         de verdad. Unas credenciales bien formadas pero equivocadas fallarian en
         la primera ejecucion del flujo, no aqui. -->
    <div class="row items-center justify-end q-gutter-sm q-mt-md">
      <span v-if="!store.connectionVerified" class="pd-subtitle pd-test-hint">
        Prueba la conexion para poder continuar.
      </span>
      <q-btn
        class="pd-btn-primary"
        unelevated
        no-caps
        label="Probar Conexion"
        icon-right="north_east"
        :disable="!store.hasValidFields"
        :loading="store.isLoading"
        @click="onTestConnection"
      />
    </div>
  </section>
</template>

<style scoped lang="scss">
.pd-node-icon {
  color: var(--pd-primary);
}

.pd-test-hint {
  max-width: 320px;
  text-align: right;
}

.pd-check-badge--ok {
  background: var(--pd-positive);
  color: #ffffff;
}

.pd-check-badge--fail {
  background: var(--pd-negative);
  color: #ffffff;
}

// Campos e inputs sobre los tokens del sistema (regla §2, Formularios). Mismo
// bloque que en los dialogos del gestor; candidato a subir a app.scss cuando se
// pueda tocar componentes ajenos a esta rama.
:deep(.q-field--outlined .q-field__control) {
  background: var(--pd-card-bg);
}

:deep(.q-field--outlined .q-field__control::before) {
  border-color: var(--pd-border);
}

:deep(.q-field__native::placeholder) {
  color: var(--pd-text-secondary);
}

:deep(.q-field__messages) {
  color: var(--pd-text-secondary);
}
</style>
