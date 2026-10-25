<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import { useQuasar } from 'quasar';

import { useCredentialsStore } from '@stores/credentials.store';

import { extractApiErrorMessage } from '@/utils/api-error';

import {
  API_KEY_NAME_PATTERN,
  API_KEY_PLACEMENT_LABELS,
  ApiKeyPlacement,
  CREDENTIAL_AUTH_TYPE_LABELS,
  CredentialAuthType,
  MAX_CREDENTIAL_NAME_LENGTH,
  MAX_SECRET_LENGTH,
} from '@/types/credential';

import type {
  Credential,
  CredentialSecretFields,
  UpdateCredentialPayload,
} from '@/types/credential';

interface Props {
  modelValue: boolean;
  credential: Credential | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  saved: [];
}>();

const $q = useQuasar();
const credentialsStore = useCredentialsStore();

const authTypeOptions = Object.values(CredentialAuthType).map((value) => ({
  label: CREDENTIAL_AUTH_TYPE_LABELS[value],
  value,
}));

const placementOptions = Object.values(ApiKeyPlacement).map((value) => ({
  label: API_KEY_PLACEMENT_LABELS[value],
  value,
}));

// Estado local del formulario. Los secretos viven SOLO aqui, mientras el
// dialogo esta abierto: se vacian al abrir y nunca se precargan, porque el
// backend no devuelve el secreto guardado (solo escritura).
const form = reactive<{
  name: string;
  authType: CredentialAuthType;
  token: string;
  username: string;
  password: string;
  keyName: string;
  apiKey: string;
  placement: ApiKeyPlacement;
}>({
  name: '',
  authType: CredentialAuthType.BEARER_TOKEN,
  token: '',
  username: '',
  password: '',
  keyName: '',
  apiKey: '',
  placement: ApiKeyPlacement.HEADER,
});

const isEditMode = computed(() => props.credential !== null);

/** Se escribio algun campo secreto: en edicion, entonces se rota el juego completo. */
const touchesSecret = computed(
  () =>
    form.authType !== props.credential?.authType ||
    [form.token, form.username, form.password, form.keyName, form.apiKey].some(
      (value) => value !== '',
    ),
);

/** En edicion, los secretos solo son obligatorios si se esta rotando. */
const secretsRequired = computed(() => !isEditMode.value || touchesSecret.value);

const resetForm = (): void => {
  form.name = props.credential?.name ?? '';
  form.authType = props.credential?.authType ?? CredentialAuthType.BEARER_TOKEN;
  form.token = '';
  form.username = '';
  form.password = '';
  form.keyName = '';
  form.apiKey = '';
  form.placement = ApiKeyPlacement.HEADER;
};

watch(
  () => props.modelValue,
  (isOpen) => {
    if (isOpen) resetForm();
  },
);

const requiredSecret = (label: string) => (val: string) =>
  !secretsRequired.value || val !== '' || `${label} es obligatorio`;

const maxSecret = (val: string) =>
  val.length <= MAX_SECRET_LENGTH || `Maximo ${MAX_SECRET_LENGTH} caracteres`;

/** Campos secretos del tipo elegido; los de otros tipos no viajan. */
const secretFields = (): CredentialSecretFields => {
  switch (form.authType) {
    case CredentialAuthType.BEARER_TOKEN:
      return { token: form.token };
    case CredentialAuthType.BASIC_AUTH:
      return { username: form.username, password: form.password };
    case CredentialAuthType.API_KEY:
      return { keyName: form.keyName, apiKey: form.apiKey, placement: form.placement };
  }
};

const onDialogToggle = (value: boolean): void => emit('update:modelValue', value);

const closeDialog = (): void => emit('update:modelValue', false);

const onSubmit = async (): Promise<void> => {
  try {
    if (props.credential !== null) {
      const payload: UpdateCredentialPayload = {
        name: form.name,
        ...(touchesSecret.value ? { authType: form.authType, ...secretFields() } : {}),
      };
      await credentialsStore.updateCredential(props.credential.id, payload);
    } else {
      await credentialsStore.createCredential({
        name: form.name,
        authType: form.authType,
        ...secretFields(),
      });
    }

    emit('saved');
    closeDialog();
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo guardar la credencial'),
    });
  }
};
</script>

<template>
  <q-dialog :model-value="modelValue" persistent @update:model-value="onDialogToggle">
    <q-card class="pd-dialog-card">
      <q-card-section class="row items-center no-wrap q-gutter-sm">
        <span class="pd-icon-circle">
          <q-icon name="key" size="20px" class="pd-dialog-icon" />
        </span>
        <div class="pd-h2">{{ isEditMode ? 'Editar credencial' : 'Nueva credencial' }}</div>
      </q-card-section>

      <q-form @submit.prevent="onSubmit">
        <q-card-section class="q-gutter-md q-pt-none">
          <div data-test="credential-name-field">
            <label class="pd-label" for="credential-name">
              Nombre<span class="pd-required">*</span>
            </label>
            <q-input
              id="credential-name"
              v-model="form.name"
              outlined
              dense
              class="q-mt-xs"
              placeholder="API de becas (produccion)"
              :maxlength="MAX_CREDENTIAL_NAME_LENGTH"
              :rules="[(val: string) => val.trim() !== '' || 'El nombre es obligatorio']"
            />
          </div>

          <!-- Selector cerrado del tipo: decide que campos secretos se piden. -->
          <div data-test="credential-type-field">
            <label class="pd-label" for="credential-type">
              Tipo de autenticacion<span class="pd-required">*</span>
            </label>
            <q-select
              id="credential-type"
              v-model="form.authType"
              :options="authTypeOptions"
              outlined
              dense
              class="q-mt-xs"
              emit-value
              map-options
            />
          </div>

          <q-banner
            v-if="isEditMode"
            dense
            class="pd-info-banner"
            data-test="credential-write-only"
          >
            <template #avatar><q-icon name="lock" /></template>
            El secreto guardado no se muestra nunca. Deja los campos vacios para conservarlo, o
            rellenalos todos para reemplazarlo.
          </q-banner>

          <template v-if="form.authType === CredentialAuthType.BEARER_TOKEN">
            <div data-test="credential-token-field">
              <label class="pd-label" for="credential-token">
                Token<span v-if="secretsRequired" class="pd-required">*</span>
              </label>
              <q-input
                id="credential-token"
                v-model="form.token"
                type="password"
                autocomplete="new-password"
                outlined
                dense
                class="q-mt-xs pd-mono"
                :rules="[requiredSecret('El token'), maxSecret]"
              />
            </div>
          </template>

          <template v-else-if="form.authType === CredentialAuthType.BASIC_AUTH">
            <div data-test="credential-username-field">
              <label class="pd-label" for="credential-username">
                Usuario<span v-if="secretsRequired" class="pd-required">*</span>
              </label>
              <q-input
                id="credential-username"
                v-model="form.username"
                autocomplete="off"
                outlined
                dense
                class="q-mt-xs"
                :rules="[
                  requiredSecret('El usuario'),
                  (val: string) => !val.includes(':') || 'El usuario no puede contener «:»',
                ]"
              />
            </div>
            <div data-test="credential-password-field">
              <label class="pd-label" for="credential-password">
                Contraseña<span v-if="secretsRequired" class="pd-required">*</span>
              </label>
              <q-input
                id="credential-password"
                v-model="form.password"
                type="password"
                autocomplete="new-password"
                outlined
                dense
                class="q-mt-xs"
                :rules="[requiredSecret('La contraseña'), maxSecret]"
              />
            </div>
          </template>

          <template v-else>
            <div data-test="credential-key-name-field">
              <label class="pd-label" for="credential-key-name">
                Nombre de la cabecera o parametro<span v-if="secretsRequired" class="pd-required"
                  >*</span
                >
              </label>
              <q-input
                id="credential-key-name"
                v-model="form.keyName"
                outlined
                dense
                class="q-mt-xs pd-mono"
                placeholder="X-Api-Key"
                :rules="[
                  requiredSecret('El nombre'),
                  (val: string) =>
                    val === '' ||
                    API_KEY_NAME_PATTERN.test(val) ||
                    'Solo letras, digitos, «-» y «_»',
                ]"
              />
            </div>
            <div data-test="credential-api-key-field">
              <label class="pd-label" for="credential-api-key">
                API key<span v-if="secretsRequired" class="pd-required">*</span>
              </label>
              <q-input
                id="credential-api-key"
                v-model="form.apiKey"
                type="password"
                autocomplete="new-password"
                outlined
                dense
                class="q-mt-xs pd-mono"
                :rules="[requiredSecret('La API key'), maxSecret]"
              />
            </div>
            <div data-test="credential-placement-field">
              <label class="pd-label" for="credential-placement">Donde viaja</label>
              <q-select
                id="credential-placement"
                v-model="form.placement"
                :options="placementOptions"
                outlined
                dense
                class="q-mt-xs"
                emit-value
                map-options
              />
            </div>
          </template>
        </q-card-section>

        <q-card-actions align="right" class="q-px-md q-pb-md">
          <q-btn flat no-caps label="Cancelar" class="pd-btn-secondary" @click="closeDialog" />
          <q-btn
            class="pd-btn-primary"
            unelevated
            no-caps
            label="Guardar"
            icon-right="north_east"
            type="submit"
            :loading="credentialsStore.isLoading"
          />
        </q-card-actions>
      </q-form>
    </q-card>
  </q-dialog>
</template>

<style scoped lang="scss">
.pd-dialog-icon {
  color: var(--pd-primary);
}

.pd-info-banner {
  background: var(--pd-surface-muted);
  color: var(--pd-text-secondary);
  border-radius: $generic-border-radius;
}

// Campos e inputs sobre los tokens del sistema (regla §2, Formularios).
:deep(.q-field--outlined .q-field__control) {
  background: var(--pd-card-bg);
}

:deep(.q-field--outlined .q-field__control::before) {
  border-color: var(--pd-border);
}

:deep(.q-field__native::placeholder) {
  color: var(--pd-text-secondary);
}
</style>
