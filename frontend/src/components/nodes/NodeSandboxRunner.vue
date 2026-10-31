<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuasar } from 'quasar';

import { canRunInSandbox, useNodeSandboxStore } from '@stores/node-sandbox.store';
import { useSessionStore } from '@stores/session.store';

import { extractApiErrorMessage } from '@/utils/api-error';
import {
  buildSampleContext,
  buildSampleOverrides,
  parseSampleContext,
  readFileAsBase64,
  withAttachment,
} from '@/utils/sandbox-sample-context';

import { BILLABLE_SANDBOX_NODE_TYPES, MAX_SANDBOX_ATTACHMENT_BYTES } from '@/types/node-sandbox';
import { NODE_TYPE_LABELS, NodeType } from '@/types/pipeline';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';
import type { SandboxAttachment } from '@/types/node-sandbox';

// Ejecucion REAL de un nodo aislado desde el banco de pruebas. Solo consume
// stores (§2.1): el anfitrion le entrega los `params` que publica el store del
// nodo (`toNodeParams()`), sin que este componente inspeccione su config.

interface Props {
  nodeType: NodeType;
  /** Lo que el nodo aportaria al `pipeline_schema`. */
  params: Record<string, unknown>;
  /** El configurador del nodo da su configuracion por valida. */
  isConfigValid: boolean;
  /** Namespaces simulados, para generar los datos de ejemplo. */
  upstream: readonly UpstreamNamespace[];
}

const props = defineProps<Props>();

const $q = useQuasar();
const sandboxStore = useNodeSandboxStore();
const sessionStore = useSessionStore();

const contextText = ref('');
const attachment = ref<SandboxAttachment | null>(null);
const attachmentFile = ref<File | null>(null);

const isRunnable = computed<boolean>(() =>
  canRunInSandbox(props.nodeType, sessionStore.user?.role),
);
const isBillable = computed<boolean>(() => BILLABLE_SANDBOX_NODE_TYPES.has(props.nodeType));
const isOcr = computed<boolean>(() => props.nodeType === NodeType.PROCESADOR_OCR);

const parsedContext = computed(() => parseSampleContext(contextText.value));
const contextError = computed<string | null>(() =>
  'error' in parsedContext.value ? parsedContext.value.error : null,
);

const canSubmit = computed<boolean>(
  () =>
    props.isConfigValid &&
    contextError.value === null &&
    !sandboxStore.isRunning &&
    (!isOcr.value || attachment.value !== null),
);

const result = computed(() => sandboxStore.lastResult);
const resultJson = computed<string>(() =>
  JSON.stringify(result.value?.success === true ? result.value.data : result.value?.error, null, 2),
);

/**
 * Ejemplos propios del nodo, serializados para vigilarlos por VALOR: `params`
 * se reconstruye en cada cambio de la config, y vigilar el objeto regeneraria
 * el ejemplo —borrando lo que el operador edito— con cada tecla.
 */
const sampleOverridesKey = computed<string>(() =>
  JSON.stringify(buildSampleOverrides(props.nodeType, props.params)),
);

/** Rehace los datos de ejemplo a partir de los namespaces simulados. */
const regenerateContext = (): void => {
  contextText.value = JSON.stringify(
    buildSampleContext(props.upstream, buildSampleOverrides(props.nodeType, props.params)),
    null,
    2,
  );
};

// Cambiar de tipo o de namespaces invalida el ejemplo y el resultado anterior.
watch(
  () => [props.nodeType, props.upstream, sampleOverridesKey.value] as const,
  () => {
    regenerateContext();
    sandboxStore.clearResult();
  },
  { immediate: true },
);

/** Valida el tamano y deja el adjunto listo para `raw_email.attachments`. */
const onAttachmentPicked = async (file: File | null): Promise<void> => {
  attachment.value = null;

  if (file === null) return;

  if (file.size > MAX_SANDBOX_ATTACHMENT_BYTES) {
    attachmentFile.value = null;
    $q.notify({ type: 'negative', message: 'El adjunto no puede superar 5 MB.' });

    return;
  }

  attachment.value = {
    filename: file.name,
    contentType: file.type,
    contentBase64: await readFileAsBase64(file),
  };
};

const execute = async (): Promise<void> => {
  if (!('context' in parsedContext.value)) return;

  const upstreamContext =
    attachment.value === null
      ? parsedContext.value.context
      : withAttachment(parsedContext.value.context, attachment.value);

  try {
    const outcome = await sandboxStore.run({
      nodeType: props.nodeType,
      params: props.params,
      upstreamContext,
    });

    $q.notify({
      type: outcome.success ? 'positive' : 'warning',
      icon: outcome.success ? 'check_circle' : 'report',
      message: outcome.success
        ? `Prueba completada en ${outcome.durationMs} ms`
        : `El nodo fallo: ${outcome.error?.message ?? 'sin detalle'}`,
    });
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo ejecutar la prueba del nodo'),
    });
  }
};

/** IA y OCR facturan: se confirma antes; HTTP se lanza directamente. */
const onRun = (): void => {
  if (!isBillable.value) {
    void execute();

    return;
  }

  $q.dialog({
    title: 'Prueba con coste',
    message: `${NODE_TYPE_LABELS[props.nodeType]} hara una inferencia REAL contra el proveedor y se facturara. ¿Continuar?`,
    cancel: { label: 'Cancelar', flat: true, noCaps: true, class: 'pd-btn-secondary' },
    ok: { label: 'Ejecutar', unelevated: true, noCaps: true, class: 'pd-btn-primary' },
    persistent: true,
  }).onOk(() => {
    void execute();
  });
};
</script>

<template>
  <section v-if="isRunnable" class="pd-sandbox-runner" data-test="sandbox-runner">
    <div class="pd-h2 q-mb-sm">Probar nodo</div>
    <p class="pd-subtitle q-mb-sm">
      Ejecuta la estrategia REAL con estos datos simulados de los pasos anteriores.
      <template v-if="isBillable">Cada prueba factura tokens.</template>
      <template v-else>La peticion se envia de verdad, por la proteccion SSRF.</template>
    </p>

    <label class="pd-label" for="sandbox-context">Datos simulados (JSON)</label>
    <q-input
      id="sandbox-context"
      v-model="contextText"
      type="textarea"
      outlined
      autogrow
      class="q-mt-xs pd-mono"
      :error="contextError !== null"
      :error-message="contextError ?? ''"
      data-test="sandbox-context"
    />
    <q-btn
      flat
      no-caps
      class="pd-btn-secondary q-mb-sm"
      icon="restart_alt"
      label="Regenerar ejemplo"
      @click="regenerateContext"
    />

    <q-file
      v-if="isOcr"
      v-model="attachmentFile"
      outlined
      dense
      accept="image/*,application/pdf"
      label="Adjunto a transcribir (imagen o PDF, max. 5 MB)"
      class="q-mb-sm"
      data-test="sandbox-attachment"
      @update:model-value="onAttachmentPicked"
    >
      <template #prepend>
        <q-icon name="attach_file" aria-hidden="true" />
      </template>
    </q-file>

    <q-btn
      class="pd-btn-primary full-width"
      unelevated
      no-caps
      icon-right="north_east"
      label="Ejecutar prueba"
      :disable="!canSubmit"
      :loading="sandboxStore.isRunning"
      data-test="sandbox-run"
      @click="onRun"
    />
    <p v-if="!isConfigValid" class="pd-subtitle q-mt-xs q-mb-none">
      Completa la configuracion del nodo para poder probarlo.
    </p>

    <div v-if="result !== null" class="q-mt-md" data-test="sandbox-result" role="status">
      <q-badge class="pd-badge" :class="result.success ? 'pd-badge--active' : 'pd-badge--failed'">
        <q-icon
          :name="result.success ? 'check_circle' : 'error'"
          size="14px"
          class="q-mr-xs"
          aria-hidden="true"
        />
        {{ result.success ? 'Exito' : `Fallo ${result.error?.level ?? ''}` }}
        · {{ result.durationMs }} ms
      </q-badge>
      <p v-if="result.error" class="pd-subtitle q-my-xs">
        <span class="pd-mono">{{ result.error.code }}</span> — {{ result.error.message }}
      </p>
      <pre class="pd-mono pd-sandbox-runner__output">{{ resultJson }}</pre>
    </div>
  </section>
</template>

<style scoped lang="scss">
// Solo maquetacion: el color proviene de los tokens --pd-*.
.pd-sandbox-runner__output {
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-border);
  border-radius: $generic-border-radius;
  padding: 8px;
}
</style>
