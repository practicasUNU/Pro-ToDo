<script setup lang="ts">
import { computed } from 'vue';

import { useQuasar } from 'quasar';

import {
  MAX_RETRIES_RULE,
  MAX_SCRAPER_RETRIES,
  MAX_SCRAPER_RETRY_DELAY_MS,
  MAX_SCRAPER_TIMEOUT_MS,
  MIN_SCRAPER_RETRY_DELAY_MS,
  MIN_SCRAPER_TIMEOUT_MS,
  RETRY_DELAY_RULE,
  TIMEOUT_RULE,
  useWebScraperStore,
} from '@stores/nodes/web-scraper.store';

import { extractApiErrorMessage } from '@/utils/api-error';

interface Props {
  nodeId: string;
}

const props = defineProps<Props>();

const $q = useQuasar();
const store = useWebScraperStore(props.nodeId);

/** Longitud minima que el backend exige para dar un texto por articulo. */
const MIN_ARTICLE_LENGTH = 200;

const TARGET_URL_HINT =
  'Se elige una REFERENCIA al contexto, no una direccion concreta: el flujo se ejecutara sobre correos distintos cada dia. La lista la componen los campos de tipo URL que publican los pasos anteriores.';

const MISSING_SOURCE_WARNING =
  'Ningun paso anterior de este flujo publica un campo del que pueda salir una URL. Coloca por delante un nodo que la produzca —un PARSER_PRE_IA extrae los enlaces del correo— o reordena el flujo; mientras tanto no hay nada que este nodo pueda extraer.';

const DISABLED_SELECT_HINT =
  'Sin origenes disponibles aguas arriba. El selector se habilita en cuanto un paso anterior publique un campo de tipo URL.';

const SKIP_IF_EMPTY_HINT =
  'Pensado para flujos de contingencia —un OCR que trabaja sobre una imagen y nunca publica enlaces—. Con la bandera activa el nodo puede guardarse y activarse sin origen: en ejecucion devuelve "scraped_web" con los campos en blanco y el flujo sigue. Nunca encubre un origen MAL configurado: ese sigue bloqueando.';

const SKIP_IF_EMPTY_LOCKED_HINT =
  'No se puede apagar: ningun paso anterior de este flujo publica una URL, asi que un extractor que exigiera origen no superaria la validacion del esquema al guardar.';

const RETRY_TOOLTIP =
  'Reintento rapido de red: cubre el corte puntual de conexion. Es independiente del "retryPolicy" del flujo, y las dos capas se multiplican.';

const SANDBOX_HINT =
  'Se prueba contra una URL REAL y completa, no contra la posicion elegida arriba: en tiempo de diseno el correo todavia no ha llegado.';

const SANDBOX_URL_PLACEHOLDER = 'https://www.ejemplo.es/noticias/nota-de-prensa';

const preview = computed(() => store.sandboxResult);

const contentLength = computed<number>(() => store.sandboxMetrics?.contentLength ?? 0);

/** Ambar cuando el texto no alcanza el minimo que el nodo exige como articulo. */
const contentBadgeClass = computed<string>(() =>
  contentLength.value >= MIN_ARTICLE_LENGTH ? 'pd-metric-badge--ok' : 'pd-metric-badge--warn',
);

const onTargetUrlChange = (targetUrl: string): void => {
  store.updateConfig({ targetUrl });
};

const onSkipIfEmptyChange = (skipIfEmpty: boolean): void => {
  store.updateConfig({ skipIfEmpty });
};

const onNumberChange = (
  field: 'timeoutMs' | 'maxRetries' | 'retryDelayMs',
  value: string | number | null,
): void => {
  store.updateConfig({ [field]: Number(value ?? 0) });
};

/**
 * Lanza la extraccion de prueba y traduce el desenlace a un aviso.
 *
 * El store no captura a proposito: aqui es donde se decide QUE lee el operador
 * (`frontend-architecture.md` §2.1). Se distinguen los dos casos porque no son
 * lo mismo: un muro de pago es una respuesta valida del portal, y un fallo de
 * red es que la llamada al backend no llego.
 */
const onRunSandboxTest = async (): Promise<void> => {
  try {
    await store.runSandboxTest();

    if (store.sandboxResult === null) {
      $q.notify({
        type: 'warning',
        message: 'No se pudo extraer el articulo',
        caption: store.sandboxWarnings[0] ?? 'Revisa el detalle del panel.',
      });

      return;
    }

    $q.notify({
      type: 'positive',
      message: `Articulo extraido: ${contentLength.value} caracteres de texto limpio.`,
    });
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo contactar con el banco de pruebas.'),
    });
  }
};
</script>

<template>
  <section class="pd-card q-pa-md" :data-node-id="nodeId">
    <!-- Cabecera -->
    <div class="row items-center no-wrap q-gutter-md q-mb-md">
      <div class="pd-icon-circle">
        <q-icon name="travel_explore" size="20px" class="pd-node-icon" />
      </div>
      <div class="col">
        <h2 class="pd-h2 q-my-none">Extractor web</h2>
        <p class="pd-subtitle q-my-none">
          Aisla el texto del articulo enlazado y lo deja en
          <span class="pd-mono">scraped_web</span>
        </p>
      </div>
      <q-badge
        class="pd-badge"
        :class="store.isConfigValid ? 'pd-badge--active' : 'pd-badge--inactive'"
        :label="store.isConfigValid ? 'Configurado' : 'Incompleto'"
      />
    </div>

    <!-- Aviso de topologia: ningun paso anterior publica un campo de tipo URL.
         Con `skipIfEmpty` sigue mostrandose, pero como dato y no como bloqueo:
         el flujo de contingencia es legitimo y no hay nada que corregir. -->
    <div
      v-if="!store.hasUrlSource"
      :class="store.config.skipIfEmpty ? 'pd-info-banner' : 'pd-warn-banner'"
      class="q-pa-md q-mb-md row items-start no-wrap q-gutter-sm"
      data-test="missing-source-warning"
    >
      <q-icon
        :name="store.config.skipIfEmpty ? 'info_outline' : 'warning_amber'"
        size="20px"
        class="pd-warn-icon"
      />
      <span class="col">{{
        store.config.skipIfEmpty ? SKIP_IF_EMPTY_HINT : MISSING_SOURCE_WARNING
      }}</span>
    </div>

    <!-- Campo 1: seleccion determinista de la URL (Poka-Yoke) -->
    <label class="pd-label" for="target-url">
      Enlace a extraer
      <span v-if="!store.config.skipIfEmpty" class="pd-required">*</span>
    </label>
    <q-select
      id="target-url"
      outlined
      dense
      emit-value
      map-options
      data-test="target-url-select"
      :model-value="store.config.targetUrl"
      :options="store.urlOptions"
      :disable="!store.hasUrlSource"
      :hint="store.hasUrlSource ? TARGET_URL_HINT : DISABLED_SELECT_HINT"
      class="q-mb-md"
      @update:model-value="onTargetUrlChange"
    >
      <template #option="scope">
        <q-item v-bind="scope.itemProps">
          <q-item-section avatar>
            <q-icon name="link" size="18px" class="pd-option-icon" />
          </q-item-section>
          <q-item-section>
            <q-item-label>{{ scope.opt.label }}</q-item-label>
            <q-item-label caption class="pd-mono pd-url-option">
              {{ scope.opt.value }}
            </q-item-label>
          </q-item-section>
        </q-item>
      </template>
    </q-select>

    <!-- Campo 1b: fallback neutro declarado (contingencia OCR) -->
    <q-toggle
      :model-value="store.config.skipIfEmpty"
      :disable="store.isSkipIfEmptyLocked"
      :class="store.isSkipIfEmptyLocked ? undefined : 'q-mb-md'"
      data-test="skip-if-empty-toggle"
      label="Omitir extraccion si la URL no existe (fallback para OCR)"
      color="primary"
      @update:model-value="onSkipIfEmptyChange"
    >
      <q-tooltip>{{ SKIP_IF_EMPTY_HINT }}</q-tooltip>
    </q-toggle>

    <!-- Se dice POR QUE esta bloqueado. Un control apagado sin explicacion se
         lee como una averia, y el operador buscaria el fallo donde no esta. -->
    <p
      v-if="store.isSkipIfEmptyLocked"
      class="pd-subtitle q-mt-xs q-mb-md"
      data-test="skip-if-empty-locked-hint"
    >
      {{ SKIP_IF_EMPTY_LOCKED_HINT }}
    </p>

    <!-- Campo 2: espera de carga -->
    <label class="pd-label" for="timeout-ms">Espera maxima de carga</label>
    <q-input
      id="timeout-ms"
      outlined
      dense
      type="number"
      suffix="ms"
      data-test="timeout-input"
      :model-value="store.config.timeoutMs"
      :min="MIN_SCRAPER_TIMEOUT_MS"
      :max="MAX_SCRAPER_TIMEOUT_MS"
      :step="1000"
      :hint="TIMEOUT_RULE"
      class="q-mb-md"
      @update:model-value="(value) => onNumberChange('timeoutMs', value)"
    />

    <!-- Campo 3: resiliencia -->
    <div class="row q-col-gutter-md q-mb-md">
      <div class="col-12 col-sm-6">
        <label class="pd-label" for="max-retries">
          Reintentos rapidos
          <q-icon name="help_outline" size="16px" class="pd-hint-icon">
            <q-tooltip>{{ RETRY_TOOLTIP }}</q-tooltip>
          </q-icon>
        </label>
        <q-input
          id="max-retries"
          outlined
          dense
          type="number"
          data-test="max-retries-input"
          :model-value="store.config.maxRetries"
          :min="0"
          :max="MAX_SCRAPER_RETRIES"
          :hint="MAX_RETRIES_RULE"
          @update:model-value="(value) => onNumberChange('maxRetries', value)"
        />
      </div>
      <div class="col-12 col-sm-6">
        <label class="pd-label" for="retry-delay-ms">Espera entre reintentos</label>
        <q-input
          id="retry-delay-ms"
          outlined
          dense
          type="number"
          suffix="ms"
          data-test="retry-delay-input"
          :model-value="store.config.retryDelayMs"
          :min="MIN_SCRAPER_RETRY_DELAY_MS"
          :max="MAX_SCRAPER_RETRY_DELAY_MS"
          :step="500"
          :hint="RETRY_DELAY_RULE"
          @update:model-value="(value) => onNumberChange('retryDelayMs', value)"
        />
      </div>
    </div>

    <!-- Avisos que no bloquean el guardado -->
    <div
      v-for="warning in store.configWarnings"
      :key="warning"
      class="pd-info-banner q-pa-sm q-mb-sm row items-start no-wrap q-gutter-sm"
      data-test="config-warning"
    >
      <q-icon name="info_outline" size="18px" class="pd-hint-icon" />
      <span class="col pd-text-secondary">{{ warning }}</span>
    </div>

    <!-- Banco de pruebas -->
    <q-card flat class="pd-sandbox-card q-pa-md q-mt-md">
      <h3 class="pd-h2 q-my-none">Probar la extraccion</h3>
      <p class="pd-subtitle q-mt-xs q-mb-md">{{ SANDBOX_HINT }}</p>

      <q-input
        outlined
        dense
        data-test="sandbox-url-input"
        :model-value="store.sandboxUrl"
        :placeholder="SANDBOX_URL_PLACEHOLDER"
        label="URL real del articulo"
        class="q-mb-md"
        @update:model-value="(value) => store.setSandboxUrl(String(value ?? ''))"
      />

      <q-btn
        unelevated
        no-caps
        class="pd-btn-primary"
        icon="play_arrow"
        label="Probar extraccion en caliente"
        data-test="run-sandbox-btn"
        :disable="!store.canRunSandbox"
        :loading="store.loading"
        @click="onRunSandboxTest"
      >
        <q-icon name="north_east" size="16px" class="q-ml-sm" />
      </q-btn>

      <!-- Panel de resultado -->
      <q-card v-if="preview" flat class="pd-result-card q-pa-md q-mt-md" data-test="sandbox-result">
        <div class="row q-col-gutter-md q-mb-md">
          <div class="col-auto">
            <div class="pd-label">Caracteres</div>
            <div class="pd-metric row items-center q-gutter-xs">
              <span class="pd-mono">{{ contentLength }}</span>
              <q-badge
                class="pd-badge"
                :class="contentBadgeClass"
                :label="`min ${MIN_ARTICLE_LENGTH}`"
              />
            </div>
          </div>
          <div class="col-auto">
            <div class="pd-label">Intentos</div>
            <div class="pd-metric pd-mono">{{ store.sandboxMetrics?.attempts ?? 1 }}</div>
          </div>
          <div class="col-auto">
            <div class="pd-label">Tiempo</div>
            <div class="pd-metric pd-mono">{{ store.sandboxMetrics?.elapsedMs ?? 0 }} ms</div>
          </div>
        </div>

        <div class="pd-label">Titulo detectado</div>
        <p class="q-mt-xs q-mb-md">{{ preview.article_title }}</p>

        <div class="pd-label">Firma</div>
        <p class="q-mt-xs q-mb-md pd-text-secondary">
          {{ preview.byline ?? 'Sin firma' }}
        </p>

        <div class="pd-label">URL final</div>
        <p class="q-mt-xs q-mb-md pd-mono pd-url-option">{{ preview.source_url }}</p>

        <div class="pd-label">Texto extraido</div>
        <pre class="pd-mono pd-body-preview q-mt-xs">{{ preview.full_article_content }}</pre>
      </q-card>

      <!-- Fallo diagnosticado: franja de severidad, no notificacion efimera -->
      <q-card
        v-else-if="store.sandboxWarnings.length > 0"
        flat
        class="pd-card--accent pd-accent-grave pd-result-card q-pa-md q-mt-md"
        data-test="sandbox-error"
      >
        <div
          v-for="warning in store.sandboxWarnings"
          :key="warning"
          class="row items-start no-wrap q-gutter-sm q-mb-xs"
        >
          <q-icon name="error_outline" size="18px" class="pd-error-icon" />
          <span class="col pd-mono">{{ warning }}</span>
        </div>
      </q-card>
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

.pd-error-icon {
  color: var(--pd-negative);
}

.pd-option-icon {
  color: var(--pd-accent);
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

// Ambar y no rojo: no llegar al minimo de caracteres no es un error del
// operador, es una propiedad de la pagina que acaba de probar.
.pd-metric-badge--warn {
  background: var(--pd-warning);
  color: var(--pd-shell-bg);
}

// `pre` y no un `div`: `full_article_content` conserva los saltos de parrafo que
// el extractor inyecta a proposito en el DOM antes de aplanar, y mostrarlos
// aplanados ocultaria justo la estructura que el modelo de inferencia recibira.
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

// Las plantillas y las URL son largas y no tienen espacios donde partir.
.pd-url-option {
  word-break: break-all;
}

// Campos e inputs sobre los tokens del sistema (regla §2, Formularios). Mismo
// bloque que en `ParserEmailConfig.vue` y `TriggerImapConfig.vue`; con la
// tercera copia, candidato claro a subir a app.scss.
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
