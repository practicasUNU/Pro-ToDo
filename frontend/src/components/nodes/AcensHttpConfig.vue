<script setup lang="ts">
import { nextTick } from 'vue';

import { useAcensHttpStore } from '@stores/nodes/acens-http.store';

import KeyValueRowsEditor from '@components/shared/KeyValueRowsEditor.vue';
import VariableInsertButton from '@components/shared/VariableInsertButton.vue';

import { blockNonNumericKeys } from '@/utils/numeric-input';
import { insertAtCaret } from '@/utils/url-source-options';

import { NODE_TYPE_LABELS, NodeType } from '@/types/pipeline';
import {
  AcensHttpMethod,
  MAX_ACENS_ENDPOINT_PATH_LENGTH,
  MAX_ACENS_TIMEOUT_MS,
  MIN_ACENS_TIMEOUT_MS,
} from '@/types/nodes/acens-http.types';
import {
  HEADER_NAME_PRESETS,
  HEADER_VALUE_PRESETS,
  MAX_KEY_VALUE_ENTRIES,
  describeHeader,
} from '@/types/nodes/http-generic-destination.types';

import type { KeyValueRow } from '@/types/nodes/http-generic-destination.types';

interface Props {
  /** Identificador del nodo en el `pipeline_schema` (contrato uniforme §3.1). */
  nodeId: string;
}

const props = defineProps<Props>();

// Store POR NODO: un flujo podria entregar a dos recursos de Acens.
const store = useAcensHttpStore(props.nodeId);

/** Campos de texto que admiten variables en el cursor. */
type InterpolableField = 'endpointPath' | 'payloadTemplate';

const DESTINATION_NOTICE =
  'Este nodo cierra el flujo: envia el resultado a la API de Acens y guarda su respuesta en acens_result. La URL base y la clave las fija el servidor (backend/.env); aqui solo se elige la ruta relativa.';

const METHOD_OPTIONS = Object.values(AcensHttpMethod).map((value) => ({ label: value, value }));

/**
 * Ultimo `<input>`/`<textarea>` enfocado de cada campo. El menu de variables le
 * roba el foco, pero el elemento conserva su seleccion: asi el marcador entra en
 * el cursor y no siempre al final (mismo patron que DrupalHttpConfig).
 */
const caretInputs = new Map<InterpolableField, HTMLInputElement | HTMLTextAreaElement>();

const rememberCaret = (field: InterpolableField, event: Event): void => {
  const { target } = event;

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    caretInputs.set(field, target);
  }
};

const insertVariable = (field: InterpolableField, token: string): void => {
  const native = caretInputs.get(field);
  const { text, caret } = insertAtCaret(
    store.config[field] ?? '',
    token,
    native?.selectionStart ?? null,
    native?.selectionEnd ?? null,
  );

  store.updateConfig({ [field]: text });
  void nextTick(() => native?.setSelectionRange(caret, caret));
};

const toNullableText = (value: string | number | null): string | null => {
  const text = String(value ?? '');

  return text.trim() === '' ? null : text;
};

const toInteger = (value: string | number | null, fallback: number): number => {
  const parsed = Number(value);

  return Number.isInteger(parsed) ? parsed : fallback;
};
</script>

<template>
  <section class="pd-card q-pa-md" :data-node-id="nodeId">
    <header class="row items-center no-wrap q-gutter-sm q-mb-md">
      <span class="pd-icon-circle">
        <q-icon name="cloud_upload" size="20px" class="pd-node-icon" />
      </span>
      <div>
        <div class="pd-h2">{{ NODE_TYPE_LABELS[NodeType.DESTINO_ACENS] }}</div>
        <div class="pd-subtitle">Entrega el resultado del flujo a la API de Acens/hosting.</div>
      </div>
    </header>

    <q-banner dense class="pd-info-banner q-mb-md" data-test="destination-notice">
      <template #avatar>
        <q-icon name="dns" size="20px" class="pd-node-icon" />
      </template>
      <p class="pd-subtitle q-mb-none">{{ DESTINATION_NOTICE }}</p>
    </q-banner>

    <h3 class="pd-h2 q-mt-lg q-mb-md">Destino</h3>

    <div class="row q-col-gutter-md items-start">
      <div class="col-12 col-md-3" data-test="method-field">
        <label class="pd-label" for="acens-method">Metodo<span class="pd-required">*</span></label>
        <q-select
          id="acens-method"
          :model-value="store.config.method"
          :options="METHOD_OPTIONS"
          outlined
          dense
          emit-value
          map-options
          class="q-mt-xs pd-mono"
          data-test="method-select"
          @update:model-value="store.updateConfig({ method: $event as AcensHttpMethod })"
        />
      </div>

      <div class="col-12 col-md-9" data-test="endpoint-field">
        <label class="pd-label" for="acens-endpoint">
          Ruta del endpoint<span class="pd-required">*</span>
        </label>
        <q-input
          id="acens-endpoint"
          :model-value="store.config.endpointPath ?? ''"
          outlined
          dense
          class="q-mt-xs pd-mono"
          placeholder="/mailing/campaigns"
          :maxlength="MAX_ACENS_ENDPOINT_PATH_LENGTH"
          hint="Relativa a la URL base del servidor y empezando por «/». La variable se inserta donde este el cursor."
          data-test="endpoint-input"
          @focus="rememberCaret('endpointPath', $event)"
          @update:model-value="store.updateConfig({ endpointPath: toNullableText($event) })"
        >
          <template #append>
            <VariableInsertButton
              :context="store.availableUpstreamContext"
              field-label="la ruta"
              @insert="insertVariable('endpointPath', $event)"
            />
          </template>
        </q-input>
      </div>
    </div>

    <h3 class="pd-h2 q-mt-lg q-mb-md">Cabeceras personalizadas</h3>
    <p class="pd-subtitle q-mb-sm">
      Authorization no se puede fijar aqui: la clave de Acens la anade el servidor.
    </p>
    <KeyValueRowsEditor
      :rows="store.config.headers"
      :context="store.availableUpstreamContext"
      :max-rows="MAX_KEY_VALUE_ENTRIES"
      test-id="headers"
      name-placeholder="X-Campaign"
      value-placeholder="{{llm_response.headline}}"
      :name-presets="HEADER_NAME_PRESETS"
      :value-presets="HEADER_VALUE_PRESETS"
      :describe-row="describeHeader"
      @update:rows="store.updateConfig({ headers: $event as KeyValueRow[] })"
    />

    <h3 class="pd-h2 q-mt-lg q-mb-md">Payload</h3>

    <div v-if="!store.isBodyless" data-test="payload-field">
      <label class="pd-label" for="acens-payload">Plantilla del payload (JSON)</label>
      <q-input
        id="acens-payload"
        :model-value="store.config.payloadTemplate ?? ''"
        type="textarea"
        autogrow
        outlined
        dense
        class="q-mt-xs pd-mono"
        placeholder='{"subject": "{{llm_response.headline}}"}'
        hint="JSON valido. Los marcadores van DENTRO de cadenas y se sustituyen valor a valor, ya desinfectados (sin etiquetas HTML)."
        data-test="payload-input"
        @focus="rememberCaret('payloadTemplate', $event)"
        @update:model-value="store.updateConfig({ payloadTemplate: toNullableText($event) })"
      >
        <template #append>
          <VariableInsertButton
            :context="store.availableUpstreamContext"
            field-label="el payload"
            @insert="insertVariable('payloadTemplate', $event)"
          />
        </template>
      </q-input>
    </div>
    <p v-else class="pd-subtitle" data-test="bodyless-notice">
      Un {{ store.config.method }} no lleva cuerpo.
    </p>

    <q-expansion-item
      class="pd-advanced q-mt-lg"
      icon="tune"
      label="Ajustes avanzados"
      header-class="pd-label"
      data-test="advanced-section"
    >
      <div class="row q-col-gutter-md q-pa-md">
        <div class="col-12 col-md-6" data-test="timeout-field">
          <label class="pd-label" for="acens-timeout">Tiempo maximo de espera (ms)</label>
          <q-input
            id="acens-timeout"
            :model-value="store.config.timeoutMs"
            type="number"
            outlined
            dense
            class="q-mt-xs"
            :min="MIN_ACENS_TIMEOUT_MS"
            :max="MAX_ACENS_TIMEOUT_MS"
            :hint="`Entre ${MIN_ACENS_TIMEOUT_MS} y ${MAX_ACENS_TIMEOUT_MS}; nunca supera el techo del servidor.`"
            @keydown="blockNonNumericKeys"
            @update:model-value="
              store.updateConfig({ timeoutMs: toInteger($event, store.config.timeoutMs) })
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
