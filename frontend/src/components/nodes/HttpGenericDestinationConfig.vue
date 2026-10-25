<script setup lang="ts">
import { onMounted } from 'vue';
import { useQuasar } from 'quasar';

import { useHttpGenericDestinationStore } from '@stores/nodes/http-generic-destination.store';

import KeyValueRowsEditor from '@components/shared/KeyValueRowsEditor.vue';
import VariableExplorer from '@components/shared/VariableExplorer.vue';

import { extractApiErrorMessage } from '@/utils/api-error';
import { blockNonNumericKeys } from '@/utils/numeric-input';

import { NODE_TYPE_LABELS, NodeType } from '@/types/pipeline';
import {
  HttpGenericAuthType,
  HttpGenericBodyType,
  HttpGenericMethod,
  MAX_HTTP_GENERIC_RETRY_ATTEMPTS,
  MAX_HTTP_GENERIC_TIMEOUT_MS,
  MAX_KEY_VALUE_ENTRIES,
  MAX_TARGET_URL_LENGTH,
  MIN_HTTP_GENERIC_TIMEOUT_MS,
} from '@/types/nodes/http-generic-destination.types';

import type { KeyValueRow } from '@/types/nodes/http-generic-destination.types';

interface Props {
  /** Identificador del nodo en el `pipeline_schema` (contrato uniforme §3.1). */
  nodeId: string;
}

const props = defineProps<Props>();

// Store POR NODO: un flujo puede notificar a dos APIs distintas.
const store = useHttpGenericDestinationStore(props.nodeId);

const $q = useQuasar();

/** Opcion de un selector cerrado con etiqueta legible. */
interface LabeledOption<T extends string> {
  readonly label: string;
  readonly value: T;
}

const DESTINATION_NOTICE =
  'Este nodo cierra el flujo: envia el resultado a una API REST publica y guarda su respuesta en http_generic_response. Los destinos de redes privadas o locales se rechazan por seguridad (SSRF).';

const METHOD_OPTIONS: readonly LabeledOption<HttpGenericMethod>[] = Object.values(
  HttpGenericMethod,
).map((value) => ({ label: value, value }));

const BODY_TYPE_OPTIONS: readonly LabeledOption<HttpGenericBodyType>[] = [
  { label: 'JSON', value: HttpGenericBodyType.JSON },
  { label: 'Texto plano', value: HttpGenericBodyType.RAW_TEXT },
  { label: 'Formulario (x-www-form-urlencoded)', value: HttpGenericBodyType.FORM_DATA },
  { label: 'Sin cuerpo', value: HttpGenericBodyType.NONE },
];

const AUTH_TYPE_OPTIONS: readonly LabeledOption<HttpGenericAuthType>[] = [
  { label: 'Sin autenticacion', value: HttpGenericAuthType.NONE },
  { label: 'Token Bearer', value: HttpGenericAuthType.BEARER_TOKEN },
  { label: 'Usuario y contrasena (Basic)', value: HttpGenericAuthType.BASIC_AUTH },
  { label: 'API key', value: HttpGenericAuthType.API_KEY },
];

const BODY_HINTS: Readonly<Record<HttpGenericBodyType, string>> = {
  [HttpGenericBodyType.JSON]:
    'JSON valido. Los marcadores van DENTRO de cadenas: {"titulo": "{{parsed_email.clean_title}}"}. Se sustituyen valor a valor, asi que unas comillas en el dato no rompen el JSON.',
  [HttpGenericBodyType.RAW_TEXT]: 'Texto libre; los marcadores se sustituyen tal cual.',
  [HttpGenericBodyType.FORM_DATA]:
    'Objeto JSON plano de cadenas; se envia como formulario: {"campo": "{{ns.valor}}"}.',
  [HttpGenericBodyType.NONE]: 'La peticion no lleva cuerpo.',
};

const appendToUrl = (token: string): void => {
  store.updateConfig({ targetUrl: `${store.config.targetUrl ?? ''}${token}` });
};

const appendToBody = (token: string): void => {
  store.updateConfig({ bodyTemplate: `${store.config.bodyTemplate ?? ''}${token}` });
};

const toNullableText = (value: string | number | null): string | null => {
  const text = String(value ?? '');

  return text.trim() === '' ? null : text;
};

const toInteger = (value: string | number | null, fallback: number): number => {
  const parsed = Number(value);

  return Number.isInteger(parsed) ? parsed : fallback;
};

onMounted(async () => {
  try {
    await store.loadCredentialOptions();
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudieron cargar las credenciales disponibles'),
    });
  }
});
</script>

<template>
  <section class="pd-card q-pa-md" :data-node-id="nodeId">
    <header class="row items-center no-wrap q-gutter-sm q-mb-md">
      <span class="pd-icon-circle">
        <q-icon name="http" size="20px" class="pd-node-icon" />
      </span>
      <div>
        <div class="pd-h2">{{ NODE_TYPE_LABELS[NodeType.DESTINO_HTTP_GENERICO] }}</div>
        <div class="pd-subtitle">Envia el resultado del flujo a cualquier API REST publica.</div>
      </div>
    </header>

    <q-banner dense class="pd-info-banner q-mb-md" data-test="destination-notice">
      <template #avatar>
        <q-icon name="public" size="20px" class="pd-node-icon" />
      </template>
      <p class="pd-subtitle q-mb-none">{{ DESTINATION_NOTICE }}</p>
    </q-banner>

    <h3 class="pd-h2 q-mt-lg q-mb-md">Destino</h3>

    <div class="row q-col-gutter-md items-start">
      <div class="col-12 col-md-3" data-test="method-field">
        <label class="pd-label" for="http-method">Metodo<span class="pd-required">*</span></label>
        <q-select
          id="http-method"
          :model-value="store.config.method"
          :options="METHOD_OPTIONS"
          outlined
          dense
          emit-value
          map-options
          class="q-mt-xs pd-mono"
          @update:model-value="store.updateConfig({ method: $event as HttpGenericMethod })"
        />
      </div>

      <div class="col-12 col-md-9" data-test="target-url-field">
        <label class="pd-label" for="http-url">
          URL de destino<span class="pd-required">*</span>
        </label>
        <q-input
          id="http-url"
          :model-value="store.config.targetUrl ?? ''"
          outlined
          dense
          class="q-mt-xs pd-mono"
          placeholder="https://api.ejemplo.org/v1/avisos"
          :maxlength="MAX_TARGET_URL_LENGTH"
          hint="Absoluta (https://...). Puede incluir variables del contexto."
          @update:model-value="store.updateConfig({ targetUrl: toNullableText($event) })"
        >
          <template #append>
            <q-btn
              flat
              dense
              round
              size="sm"
              icon="data_object"
              aria-label="Insertar variable en la URL"
            >
              <q-tooltip>Insertar una variable del contexto</q-tooltip>
              <q-menu anchor="bottom right" self="top right" class="pd-card q-pa-md">
                <VariableExplorer
                  :context="store.availableUpstreamContext"
                  insert-label="Insertar en la URL"
                  @insert="appendToUrl"
                />
              </q-menu>
            </q-btn>
          </template>
        </q-input>
      </div>
    </div>

    <h3 class="pd-h2 q-mt-lg q-mb-md">Cabeceras</h3>
    <p class="pd-subtitle q-mb-sm">
      Authorization y Cookie no se pueden fijar aqui: la autenticacion va por credencial.
    </p>
    <KeyValueRowsEditor
      :rows="store.config.headers"
      :context="store.availableUpstreamContext"
      :max-rows="MAX_KEY_VALUE_ENTRIES"
      test-id="headers"
      name-placeholder="X-Origen"
      @update:rows="store.updateConfig({ headers: $event as KeyValueRow[] })"
    />

    <h3 class="pd-h2 q-mt-lg q-mb-md">Parametros de consulta</h3>
    <KeyValueRowsEditor
      :rows="store.config.queryParams"
      :context="store.availableUpstreamContext"
      :max-rows="MAX_KEY_VALUE_ENTRIES"
      test-id="query"
      name-placeholder="lang"
      @update:rows="store.updateConfig({ queryParams: $event as KeyValueRow[] })"
    />

    <h3 class="pd-h2 q-mt-lg q-mb-md">Cuerpo</h3>

    <div class="row q-col-gutter-md items-start">
      <div class="col-12 col-md-4" data-test="body-type-field">
        <label class="pd-label" for="http-body-type">Tipo de cuerpo</label>
        <q-select
          id="http-body-type"
          :model-value="store.config.bodyType"
          :options="BODY_TYPE_OPTIONS"
          outlined
          dense
          emit-value
          map-options
          class="q-mt-xs"
          :disable="store.isBodyless"
          :hint="store.isBodyless ? `Un ${store.config.method} no lleva cuerpo.` : undefined"
          @update:model-value="store.updateConfig({ bodyType: $event as HttpGenericBodyType })"
        />
      </div>

      <div
        v-if="store.config.bodyType !== HttpGenericBodyType.NONE"
        class="col-12"
        data-test="body-template-field"
      >
        <div class="row items-center justify-between">
          <label class="pd-label" for="http-body">Plantilla del cuerpo</label>
          <q-btn
            flat
            dense
            no-caps
            icon="data_object"
            label="Insertar variable"
            class="pd-insert-btn"
          >
            <q-menu anchor="bottom right" self="top right" class="pd-card q-pa-md">
              <VariableExplorer
                :context="store.availableUpstreamContext"
                insert-label="Insertar en el cuerpo"
                @insert="appendToBody"
              />
            </q-menu>
          </q-btn>
        </div>
        <q-input
          id="http-body"
          :model-value="store.config.bodyTemplate ?? ''"
          type="textarea"
          autogrow
          outlined
          dense
          class="q-mt-xs pd-mono"
          :hint="BODY_HINTS[store.config.bodyType]"
          @update:model-value="store.updateConfig({ bodyTemplate: toNullableText($event) })"
        />
      </div>
    </div>

    <h3 class="pd-h2 q-mt-lg q-mb-md">Autenticacion</h3>

    <div class="row q-col-gutter-md items-start">
      <div class="col-12 col-md-5" data-test="auth-type-field">
        <label class="pd-label" for="http-auth-type">Esquema</label>
        <q-select
          id="http-auth-type"
          :model-value="store.config.authType"
          :options="AUTH_TYPE_OPTIONS"
          outlined
          dense
          emit-value
          map-options
          class="q-mt-xs"
          @update:model-value="store.updateConfig({ authType: $event as HttpGenericAuthType })"
        />
      </div>

      <!-- Selector CERRADO (Poka-Yoke §4): solo credenciales de la boveda del
           tipo elegido. El secreto no llega nunca al navegador. -->
      <div v-if="store.requiresCredential" class="col-12 col-md-7" data-test="credential-field">
        <label class="pd-label" for="http-credential">
          Credencial<span class="pd-required">*</span>
        </label>
        <q-select
          id="http-credential"
          :model-value="store.config.credentialId"
          :options="store.credentialOptions"
          option-value="id"
          option-label="name"
          outlined
          dense
          emit-value
          map-options
          class="q-mt-xs"
          no-error-icon
          hint="Las credenciales las gestiona un administrador en «Credenciales»."
          @update:model-value="
            store.updateConfig({ credentialId: ($event as string | null) ?? null })
          "
        >
          <template #no-option>
            <q-item>
              <q-item-section class="pd-subtitle">
                No hay credenciales de este tipo en la boveda.
              </q-item-section>
            </q-item>
          </template>
        </q-select>
      </div>
    </div>

    <q-expansion-item
      class="pd-advanced q-mt-lg"
      icon="tune"
      label="Ajustes avanzados"
      header-class="pd-label"
      data-test="advanced-section"
    >
      <div class="row q-col-gutter-md q-pa-md">
        <div class="col-12 col-md-6" data-test="timeout-field">
          <label class="pd-label" for="http-timeout">Tiempo maximo de espera (ms)</label>
          <q-input
            id="http-timeout"
            :model-value="store.config.timeoutMs"
            type="number"
            outlined
            dense
            class="q-mt-xs"
            :min="MIN_HTTP_GENERIC_TIMEOUT_MS"
            :max="MAX_HTTP_GENERIC_TIMEOUT_MS"
            :hint="`Entre ${MIN_HTTP_GENERIC_TIMEOUT_MS} y ${MAX_HTTP_GENERIC_TIMEOUT_MS}.`"
            @keydown="blockNonNumericKeys"
            @update:model-value="
              store.updateConfig({ timeoutMs: toInteger($event, store.config.timeoutMs) })
            "
          />
        </div>
        <div class="col-12 col-md-6" data-test="retry-field">
          <label class="pd-label" for="http-retries">Reintentos ante fallo transitorio</label>
          <q-input
            id="http-retries"
            :model-value="store.config.retryAttempts"
            type="number"
            outlined
            dense
            class="q-mt-xs"
            :min="0"
            :max="MAX_HTTP_GENERIC_RETRY_ATTEMPTS"
            hint="0 por defecto: un POST reintentado puede duplicar el recurso."
            @keydown="blockNonNumericKeys"
            @update:model-value="
              store.updateConfig({ retryAttempts: toInteger($event, store.config.retryAttempts) })
            "
          />
        </div>
      </div>
    </q-expansion-item>

    <q-banner
      v-if="store.malformedParams.length > 0"
      dense
      class="pd-error-banner q-mt-md"
      data-test="config-errors"
    >
      <template #avatar><q-icon name="error_outline" class="pd-error-icon" /></template>
      <ul class="q-my-none q-pl-md">
        <li v-for="problem in store.malformedParams" :key="problem">{{ problem }}</li>
      </ul>
    </q-banner>

    <q-banner
      v-for="warning in store.configWarnings"
      :key="warning"
      dense
      class="pd-warn-banner q-mt-md"
      data-test="config-warning"
    >
      <template #avatar><q-icon name="warning_amber" class="pd-warn-icon" /></template>
      {{ warning }}
    </q-banner>
  </section>
</template>

<style scoped lang="scss">
// Solo maquetacion: el color proviene de los tokens --pd-*.
.pd-node-icon {
  color: var(--pd-primary);
}

.pd-warn-icon {
  color: var(--pd-warning);
}

.pd-error-icon {
  color: var(--pd-negative);
}

.pd-info-banner {
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-border);
  border-radius: $generic-border-radius;
  color: var(--pd-text-primary);
}

.pd-warn-banner {
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-warning);
  border-radius: $generic-border-radius;
  color: var(--pd-text-primary);
}

.pd-error-banner {
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-negative);
  border-radius: $generic-border-radius;
  color: var(--pd-text-primary);
}

.pd-insert-btn {
  color: var(--pd-accent-text);
}

.pd-advanced {
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-border);
  border-radius: $generic-border-radius;
}

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
