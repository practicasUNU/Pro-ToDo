<script setup lang="ts">
import { computed } from 'vue';
import { useQuasar } from 'quasar';

import {
  DEFAULT_MIN_BODY_LENGTH,
  EXCLUDABLE_EXTENSION_PRESETS,
  MIN_BODY_LENGTH,
  MIN_BODY_LENGTH_RULE,
  useParserEmailStore,
} from '@stores/nodes/parser-email.store';

import { extractApiErrorMessage } from '@/utils/api-error';

import { NODE_TYPE_LABELS, NodeType } from '@/types/pipeline';
import { blockNonNumericKeys } from '@/utils/numeric-input';

import type { BodySource } from '@/types/parser-email';

interface Props {
  /** Identificador del nodo en el `pipeline_schema` (contrato uniforme §3.1). */
  nodeId: string;
}

const props = defineProps<Props>();

const $q = useQuasar();
// El store se resuelve POR NODO: dos parsers en el mismo flujo tienen cada uno
// su propia configuracion, no una compartida.
const store = useParserEmailStore(props.nodeId);

// Mensajes como constantes: el mismo texto lo usan la regla del campo y la ayuda
// bajo el input, y duplicarlo los dejaria divergir.
const MIN_BODY_LENGTH_HINT = `Caracteres del cuerpo YA SANEADO por debajo de los cuales se considera que el correo no trae texto aprovechable. Por defecto ${DEFAULT_MIN_BODY_LENGTH}.`;

const SKIP_DOCUMENTS_HINT =
  'Los adjuntos se conservan intactos para los nodos de destino; lo unico que se omite es volcar su texto al prompt del modelo.';

const EXCLUDED_EXTENSIONS_HINT =
  'Elige las extensiones cuyo texto NO quieres volcar al prompt. Solo se ofrecen los formatos que el backend sabe leer: excluir cualquier otro no tendria efecto.';

const SKIP_DOCUMENTS_NOTICE =
  'Se ignorara el contenido de todos los documentos para la IA; el archivo fisico se mantiene intacto para su subida a Drupal/Acens.';

const MULTIMODAL_TOOLTIP =
  'Si el texto util resultante —cuerpo limpio MAS el texto nativo extraido de los adjuntos— tiene menos de este numero de caracteres y queda algun adjunto de imagen o PDF del que no se saco ni un caracter, el motor FSM preservara los binarios para el procesamiento multimodal por IA.';

const MULTIMODAL_RULE =
  'El nodo solo pide un modelo con vision cuando se cumplen LAS DOS condiciones a la vez: que el correo traiga al menos un adjunto de tipo imagen o PDF, Y que el cuerpo saneado quede por debajo del umbral.';

const MULTIMODAL_RULE_WHY =
  'El Y es deliberado: un boletin con el logo en PNG y cinco mil caracteres de texto no necesita vision, y gastarla ahi seria la llamada mas cara del flujo sin motivo. El caso que si la merece es el contrario: un correo cuyo unico contenido real es un PDF escaneado o una captura.';

const SOURCE_NAMESPACE_HINT =
  'El nodo lee siempre del namespace raw_email, que es el que deja el disparador de correo. No se expone como campo porque leer de otro sitio es un cambio de topologia del flujo, no de configuracion del nodo.';

const SANDBOX_HINT =
  'El backend sanea este correo con la MISMA funcion que ejecutara el flujo: lo que se vea aqui es lo que llegara al nodo de inferencia.';

/** Umbral de reduccion que RNF-01 exige a un correo HTML realista. */
const RNF01_TARGET_REDUCTION = 50;

/** Traduccion legible de `body_source`. */
const BODY_SOURCE_LABELS: Record<BodySource, string> = {
  text: 'Cuerpo en texto plano',
  html: 'Cuerpo en HTML',
  none: 'El correo no traia cuerpo aprovechable',
};

const parsed = computed(() => store.sandboxResult);

/**
 * Clase del badge de reduccion.
 *
 * Verde a partir del objetivo de RNF-01 y ambar por debajo: no es decoracion,
 * es el criterio de aceptacion del nodo hecho visible sobre el correo concreto
 * que el operador acaba de pegar.
 */
const reductionBadgeClass = computed<string>(() =>
  (parsed.value?.reduction_percentage ?? 0) >= RNF01_TARGET_REDUCTION
    ? 'pd-metric-badge--ok'
    : 'pd-metric-badge--warn',
);

/**
 * Prueba el saneado y traduce el resultado a una notificacion.
 *
 * El store no captura el error a proposito (`frontend-architecture.md` §2.1):
 * decidir el mensaje es competencia de la vista. Se distinguen los dos fallos
 * posibles: el que el backend diagnostica (200 con `success: false`, que deja
 * `sandboxResult` a null) y el que rompe la llamada (excepcion, incluido el 400
 * por superar el tope de caracteres).
 */
const onRunSandboxTest = async (): Promise<void> => {
  try {
    await store.runSandboxTest();

    if (store.sandboxResult === null) {
      $q.notify({
        type: 'negative',
        message: store.sandboxWarnings[0] ?? 'No se pudo procesar el correo de prueba',
      });
      return;
    }

    $q.notify({
      type: 'positive',
      message: `Correo procesado: ${store.sandboxResult.character_count} caracteres utiles.`,
    });
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo probar el saneado del correo'),
    });
  }
};
</script>

<template>
  <section class="pd-card q-pa-md" :data-node-id="nodeId">
    <header class="row items-center no-wrap q-gutter-sm q-mb-md">
      <span class="pd-icon-circle">
        <q-icon name="cleaning_services" size="20px" class="pd-node-icon" />
      </span>
      <div>
        <div class="pd-h2">{{ NODE_TYPE_LABELS[NodeType.PARSER_PRE_IA] }}</div>
        <div class="pd-subtitle">
          Limpia el correo, extrae sus enlaces de contenido y decide si el flujo puede seguir con
          texto o necesita un modelo con vision.
        </div>
      </div>
      <q-space />
      <q-badge v-if="parsed" class="pd-badge" :class="reductionBadgeClass">
        Reduccion {{ parsed.reduction_percentage }}%
      </q-badge>
    </header>

    <!-- UNICO campo del formulario. `sourceNamespace` no se expone: queda en su
         defecto `raw_email` (ver el TSDoc de `toNodeParams` en el store). -->
    <div class="row q-col-gutter-md items-start">
      <div class="col-12 col-md-6">
        <label class="pd-label" for="parser-min-body-length">
          Umbral de cuerpo util (caracteres)<span class="pd-required">*</span>
          <q-icon name="help_outline" size="15px" class="q-ml-xs pd-hint-icon">
            <q-tooltip max-width="320px">{{ MULTIMODAL_TOOLTIP }}</q-tooltip>
          </q-icon>
        </label>
        <q-input
          id="parser-min-body-length"
          :model-value="store.config.minBodyLength"
          type="number"
          @keydown="blockNonNumericKeys"
          :min="MIN_BODY_LENGTH"
          step="1"
          outlined
          dense
          class="q-mt-xs"
          :hint="MIN_BODY_LENGTH_HINT"
          :rules="[
            (val: number | string | null) =>
              (val !== null && val !== '' && Number(val) >= MIN_BODY_LENGTH) ||
              MIN_BODY_LENGTH_RULE,
          ]"
          @update:model-value="store.updateConfig({ minBodyLength: Number($event) })"
        />
      </div>

      <div class="col-12 col-md-6">
        <div class="pd-label">Namespace de lectura</div>
        <div class="pd-mono pd-readonly-value q-mt-xs">
          {{ store.config.sourceNamespace }}
          <q-icon name="lock_outline" size="15px" class="q-ml-xs pd-hint-icon">
            <q-tooltip max-width="320px">{{ SOURCE_NAMESPACE_HINT }}</q-tooltip>
          </q-icon>
        </div>
      </div>
    </div>

    <div class="row q-col-gutter-md items-start q-mt-xs">
      <div class="col-12" data-test="skip-document-extraction">
        <q-toggle
          :model-value="store.config.skipDocumentExtraction"
          color="primary"
          label="Omitir extraccion de documentos adjuntos"
          @update:model-value="store.updateConfig({ skipDocumentExtraction: Boolean($event) })"
        />
        <p class="pd-subtitle q-mt-xs q-mb-none">{{ SKIP_DOCUMENTS_HINT }}</p>
      </div>

      <!-- Con el interruptor activo el selector de abajo queda sin sentido, asi
           que en su lugar se dice en voz alta que pasa con los ficheros: la
           duda real del operador es si el adjunto se pierde, y no se pierde. -->
      <div
        v-if="store.config.skipDocumentExtraction"
        class="col-12"
        data-test="skip-documents-notice"
      >
        <q-banner dense class="pd-info-banner">
          <template #avatar>
            <q-icon name="info_outline" size="20px" class="pd-node-icon" />
          </template>
          {{ SKIP_DOCUMENTS_NOTICE }}
        </q-banner>
      </div>

      <div class="col-12 col-md-8" data-test="excluded-extensions">
        <label class="pd-label" for="parser-excluded-extensions">
          Extensiones excluidas de la extraccion
        </label>
        <!-- Deshabilitado cuando ya se omiten todos: una lista de excepciones
             sobre un "ninguno" no excluye nada y solo confunde.

             Selector CERRADO (§4 Poka-Yoke): sin `use-input` ni
             `new-value-mode`. Las opciones son las extensiones que el backend
             sabe leer de verdad; excluir una que no lee no excluye nada. -->
        <q-select
          id="parser-excluded-extensions"
          :model-value="store.config.excludedExtensions"
          :options="EXCLUDABLE_EXTENSION_PRESETS"
          :disable="store.config.skipDocumentExtraction"
          multiple
          use-chips
          outlined
          dense
          class="q-mt-xs"
          :hint="EXCLUDED_EXTENSIONS_HINT"
          @update:model-value="
            store.updateConfig({ excludedExtensions: ($event as string[]) ?? [] })
          "
        />
      </div>
    </div>

    <!-- Panel de la regla multimodal. No es decoracion: el umbral de arriba solo
         tiene sentido si se sabe que decide, y el Y es justo lo que un operador
         da por supuesto al reves. -->
    <q-banner dense class="pd-info-banner q-mt-md">
      <template #avatar>
        <q-icon name="visibility" size="20px" class="pd-node-icon" />
      </template>
      <div class="pd-label q-mb-xs">Cuando se pide un modelo con vision</div>
      <p class="pd-subtitle q-mb-xs">{{ MULTIMODAL_RULE }}</p>
      <p class="pd-subtitle q-mb-none">{{ MULTIMODAL_RULE_WHY }}</p>
    </q-banner>

    <!-- Banco de pruebas. Opcional: no condiciona `isConfigValid`. -->
    <h3 class="pd-h2 q-mt-lg q-mb-xs">Probar el saneado</h3>
    <p class="pd-subtitle q-mb-md">{{ SANDBOX_HINT }}</p>

    <q-card flat class="pd-sandbox-card q-pa-md">
      <div class="row q-col-gutter-md">
        <div class="col-12">
          <label class="pd-label" for="parser-sandbox-subject">Asunto de ejemplo</label>
          <q-input
            id="parser-sandbox-subject"
            :model-value="store.sandboxInput.subject"
            outlined
            dense
            class="q-mt-xs"
            placeholder="RV: Re: Nota de prensa institucional"
            @update:model-value="store.updateSandboxInput({ subject: String($event ?? '') })"
          />
        </div>

        <div class="col-12 col-md-6">
          <label class="pd-label" for="parser-sandbox-html">Cuerpo en HTML</label>
          <q-input
            id="parser-sandbox-html"
            :model-value="store.sandboxInput.html"
            type="textarea"
            rows="7"
            outlined
            dense
            class="q-mt-xs pd-mono"
            hint="Plan B del multipart/alternative sin parte de texto: el caso habitual de un boletin."
            @update:model-value="store.updateSandboxInput({ html: String($event ?? '') })"
          />
        </div>

        <div class="col-12 col-md-6">
          <label class="pd-label" for="parser-sandbox-text">Cuerpo en texto plano</label>
          <q-input
            id="parser-sandbox-text"
            :model-value="store.sandboxInput.text"
            type="textarea"
            rows="7"
            outlined
            dense
            class="q-mt-xs"
            hint="Si viene relleno, el nodo lo prefiere sobre el HTML y no extrae enlaces."
            @update:model-value="store.updateSandboxInput({ text: String($event ?? '') })"
          />
        </div>

        <div class="col-12">
          <q-toggle
            :model-value="store.sandboxInput.simulateVisualAttachment"
            color="primary"
            label="Simular un adjunto PDF"
            @update:model-value="
              store.updateSandboxInput({ simulateVisualAttachment: Boolean($event) })
            "
          >
            <q-tooltip max-width="320px">
              Necesario para observar la regla multimodal: sin un adjunto interpretable por vision,
              la bandera nunca se activa por muy corto que sea el cuerpo.
            </q-tooltip>
          </q-toggle>
        </div>
      </div>

      <div class="row justify-end q-mt-md">
        <q-btn
          class="pd-btn-primary"
          unelevated
          no-caps
          label="Probar Saneado"
          icon-right="north_east"
          :disable="!store.canRunSandbox"
          :loading="store.loading"
          @click="onRunSandboxTest"
        >
          <q-tooltip v-if="!store.canRunSandbox">
            Pega el texto o el HTML de un correo de ejemplo para poder probar.
          </q-tooltip>
        </q-btn>
      </div>
    </q-card>

    <!-- Avisos que la ejecucion real solo deja en el `.log` del servidor. -->
    <q-banner
      v-for="warning in store.sandboxWarnings"
      :key="warning"
      dense
      class="pd-warn-banner q-mt-md"
    >
      <template #avatar>
        <q-icon name="warning_amber" size="20px" class="pd-warn-icon" />
      </template>
      {{ warning }}
    </q-banner>

    <q-card v-if="parsed" flat class="pd-result-card q-pa-md q-mt-md">
      <div class="row items-center q-gutter-sm q-mb-md">
        <div class="pd-h2">Resultado del saneado</div>
        <q-space />
        <q-badge class="pd-badge pd-badge--active">
          {{ BODY_SOURCE_LABELS[parsed.body_source] ?? parsed.body_source }}
          <q-tooltip max-width="320px">
            Clave body_source del payload: es la que explica POR QUE el cuerpo esta como esta.
          </q-tooltip>
        </q-badge>
      </div>

      <div class="row q-col-gutter-sm q-mb-md">
        <div class="col-6 col-md-3">
          <div class="pd-label">Caracteres utiles</div>
          <div class="pd-mono pd-metric">{{ parsed.character_count }}</div>
        </div>
        <div class="col-6 col-md-3">
          <div class="pd-label">Origen consumido</div>
          <div class="pd-mono pd-metric">{{ parsed.original_character_count }}</div>
        </div>
        <div class="col-6 col-md-3">
          <div class="pd-label">Reduccion (RNF-01)</div>
          <q-badge class="pd-badge pd-metric-badge q-mt-xs" :class="reductionBadgeClass">
            {{ parsed.reduction_percentage }}%
            <q-tooltip max-width="320px">
              Medida contra la fuente CONSUMIDA (texto o HTML), no contra el correo entero: la
              pareja original/final tiene que ser la entrada y la salida de la MISMA transformacion.
              RNF-01 exige al menos un {{ RNF01_TARGET_REDUCTION }}%.
            </q-tooltip>
          </q-badge>
        </div>
        <div class="col-6 col-md-3">
          <div class="pd-label">Adjuntos</div>
          <div class="pd-mono pd-metric">{{ parsed.attachment_count }}</div>
        </div>
      </div>

      <div class="pd-label q-mb-xs">Titulo limpio</div>
      <p class="pd-subtitle q-mb-md">{{ parsed.clean_title || '—' }}</p>

      <div class="pd-label q-mb-xs">Cuerpo limpio</div>
      <pre class="pd-mono pd-body-preview q-mb-md">{{ parsed.clean_body || '(vacio)' }}</pre>

      <div class="pd-label q-mb-xs">Enlaces extraidos ({{ parsed.extracted_urls.length }})</div>
      <div v-if="parsed.extracted_urls.length > 0" class="pd-url-list q-mb-md">
        <q-badge
          v-for="url in parsed.extracted_urls"
          :key="url"
          class="pd-badge pd-mono pd-url-chip"
          :label="url"
        />
      </div>
      <p v-else class="pd-subtitle q-mb-md">
        Sin enlaces de contenido. Los enlaces se leen siempre del marcado, aunque el cuerpo venga
        del texto plano, asi que un correo sin parte HTML o cuyo marcado no declare ningun
        <span class="pd-mono">&lt;a href&gt;</span> valido sale vacio. El nodo
        <span class="pd-mono">EXTRACTOR_WEB</span> no recibiria nada que escrapear.
      </p>

      <div class="pd-label q-mb-xs">Texto nativo de los adjuntos</div>
      <p class="pd-subtitle q-mb-xs">
        Extraccion SIN OCR de .pdf, .docx, .xlsx, .csv y .txt. En este banco de pruebas sale siempre
        vacio: el endpoint no recibe los binarios de los adjuntos, solo sus metadatos.
      </p>
      <pre class="pd-mono pd-body-preview q-mb-md">{{
        parsed.extracted_documents_text || '(sin texto documental)'
      }}</pre>

      <div class="pd-label q-mb-xs">Respaldo multimodal</div>
      <q-banner v-if="parsed.requires_multimodal_fallback" dense class="pd-warn-banner">
        <template #avatar>
          <q-icon name="visibility" size="20px" class="pd-warn-icon" />
        </template>
        {{ parsed.multimodal_reason }}
      </q-banner>
      <p v-else class="pd-subtitle q-mb-none">
        No hace falta: entre el cuerpo y los adjuntos hay texto suficiente, o no queda ningun
        adjunto de imagen o PDF del que no se haya podido extraer texto.
      </p>
    </q-card>
  </section>
</template>

<style scoped lang="scss">
.pd-node-icon {
  color: var(--pd-primary);
}

.pd-hint-icon {
  color: var(--pd-text-secondary);
}

.pd-warn-icon {
  color: var(--pd-warning);
}

.pd-readonly-value {
  color: var(--pd-text-secondary);
  line-height: 40px;
}

.pd-info-banner,
.pd-sandbox-card,
.pd-result-card {
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-border);
  border-radius: $generic-border-radius;
  color: var(--pd-text-primary);
}

.pd-warn-banner {
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-border);
  border-left: 3px solid var(--pd-warning);
  border-radius: $generic-border-radius;
  color: var(--pd-text-primary);
}

.pd-metric {
  color: var(--pd-text-primary);
  font-size: 18px;
  line-height: 26px;
}

.pd-metric-badge--ok {
  background: var(--pd-positive);
  color: #ffffff;
}

// Ambar y no rojo: quedarse por debajo del objetivo de RNF-01 no es un error del
// operador, es una propiedad del correo que acaba de pegar.
.pd-metric-badge--warn {
  background: var(--pd-warning);
  color: var(--pd-shell-bg);
}

// `pre` y no un `div`: `clean_body` conserva los saltos de parrafo que el
// saneador normalizo, y aplanarlos ocultaria justo la estructura que el nodo
// produce y que el modelo de inferencia va a recibir.
.pd-body-preview {
  background: var(--pd-card-bg);
  border: 1px solid var(--pd-border);
  border-radius: $generic-border-radius;
  color: var(--pd-text-primary);
  padding: 12px;
  margin: 0;
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.pd-url-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
}

.pd-url-chip {
  background: var(--pd-accent-soft);
  color: var(--pd-accent-text);
  max-width: 100%;
  word-break: break-all;
}

// Campos e inputs sobre los tokens del sistema (regla §2, Formularios). Mismo
// bloque que en `TriggerImapConfig.vue`; candidato a subir a app.scss cuando se
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
