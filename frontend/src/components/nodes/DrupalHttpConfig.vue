<script setup lang="ts">
import { useQuasar } from 'quasar';
import { computed } from 'vue';

import { useDrupalHttpStore } from '@stores/nodes/drupal-http.store';

import { NODE_TYPE_LABELS, NodeType } from '@/types/pipeline';
import {
  DRUPAL_BUNDLES,
  DRUPAL_SANDBOX_PRESETS,
  DrupalOperationMode,
  MAX_DRUPAL_ATTACHMENT_INDEX,
  MAX_DRUPAL_SELECTOR_LENGTH,
  MAX_DRUPAL_SUMMARY_LENGTH,
  MAX_DRUPAL_TITLE_LENGTH,
  UUID_V4_PATTERN,
} from '@/types/nodes/drupal-http.types';

import type { DrupalInsertPosition, DrupalSandboxPresetKey } from '@/types/nodes/drupal-http.types';

interface Props {
  /** Identificador del nodo en el `pipeline_schema` (contrato uniforme §3.1). */
  nodeId: string;
}

const props = defineProps<Props>();

// El store se resuelve POR NODO: un flujo puede publicar la noticia y, ademas,
// mover su licitacion a la pagina de cerradas, con configuraciones distintas.
const store = useDrupalHttpStore(props.nodeId);

const $q = useQuasar();

/**
 * Carga un destino y lo confirma por `q-notify`.
 *
 * El acuse importa: un preset escribe siete campos repartidos por secciones que
 * pueden estar plegadas, de modo que sin aviso el unico indicio visible de que
 * el boton hizo algo seria el UUID. Los presets de traslado dejan ademas un
 * campo obligatorio vacio A PROPOSITO, y el aviso lo dice para que no se lea
 * como un fallo del boton.
 */
const onPresetClick = (presetKey: DrupalSandboxPresetKey): void => {
  store.applyPreset(presetKey);

  const needsDestination =
    DRUPAL_SANDBOX_PRESETS[presetKey].operationMode === DrupalOperationMode.TRANSFER_HTML_BLOCK;

  $q.notify({
    type: needsDestination ? 'warning' : 'positive',
    message: needsDestination ? TRANSFER_NOTICE : 'Preset cargado exitosamente',
    timeout: needsDestination ? 6000 : 2000,
  });
};

/** Opcion de un selector cerrado con etiqueta legible. */
interface LabeledOption {
  readonly label: string;
  readonly value: string;
}

// Mensajes como constantes de modulo: varios los comparten la ayuda del campo y
// el texto de la seccion, y duplicarlos los dejaria divergir.
const DESTINATION_NOTICE =
  'Este nodo cierra el flujo: publica el resultado en Drupal por JSON:API y devuelve el acuse. Nada corre despues de el, asi que un fallo aqui deja el trabajo hecho sin publicar.';

const MODE_HINT =
  'Cada modo es un trabajo distinto contra el CMS y pide sus propios campos. Cambiarlo cambia tambien lo que el flujo exige aguas arriba.';

const BUNDLE_HINT =
  'Es el `data.type` de JSON:API, en la forma entidad--bundle. De el se deriva la ruta de coleccion.';

/**
 * Icono de cada destino operativo.
 *
 * Vive aqui y no en el catalogo de tipos porque es decision de PRESENTACION:
 * `DRUPAL_SANDBOX_PRESETS` describe una configuracion de Drupal y no deberia
 * saber que existe Material Icons. El `Record` es completo, de modo que anadir
 * un preset sin icono no compila.
 */
const PRESET_ICONS: Readonly<Record<DrupalSandboxPresetKey, string>> = {
  ABRIR_LICITACION: 'post_add',
  CERRAR_LICITACION: 'archive',
  VERIFICACION_TITULOS: 'school',
};

const SANDBOX_NOTICE =
  'Destinos confirmados en produccion. Cada uno rellena identificador, bundle, modo y selectores a la vez: por separado no significan nada.';

/**
 * Por que «Cerrar licitacion» deja un campo pendiente.
 *
 * Sin este aviso el operador lee el asterisco de `destinationNodeUuid` como un
 * fallo del preset y vuelve a pulsarlo. La pagina de licitaciones CERRADAS no
 * tiene UUID conocido todavia, y apuntarla a la de abiertas «para probar» seria
 * destructivo (ver el TSDoc de `destinationNodeUuid` en los tipos).
 */
const TRANSFER_NOTICE =
  'Cerrar licitacion deja a proposito la pagina de destino sin rellenar: hay que indicar la de licitaciones cerradas antes de poder guardar.';

const SOURCE_HINT =
  'Solo se ofrecen los namespaces que publican los pasos ANTERIORES de este flujo. Elegir uno que nadie produzca rechaza el guardado con ERR_MISSING_UPSTREAM_CONTEXT.';

const UUID_HINT = 'UUID v4 de la entidad en Drupal. Usa los botones de sandbox para no teclearlo.';

const ATTACHMENT_NOTICE =
  'El binario sale del inventario de adjuntos del correo. El motor libera esos bytes en cuanto un nodo publica texto, asi que este paso debe ir ANTES del parser.';

const ADVANCED_NOTICE =
  'Valores que el backend ya resuelve por defecto. Tocalos solo si este Drupal se aparta de la instalacion estandar.';

/** Etiquetas de los cuatro modos, en el orden en que se suelen elegir. */
const MODE_OPTIONS: readonly LabeledOption[] = [
  {
    label: 'Crear contenido nuevo (una noticia por ejecucion)',
    value: DrupalOperationMode.CREATE_NODE,
  },
  {
    label: 'Anadir bloque a una pagina agregadora (abrir licitacion)',
    value: DrupalOperationMode.APPEND_HTML_BLOCK,
  },
  {
    label: 'Mover un bloque entre dos paginas (cerrar licitacion)',
    value: DrupalOperationMode.TRANSFER_HTML_BLOCK,
  },
  {
    label: 'Subir un adjunto del correo como fichero',
    value: DrupalOperationMode.UPLOAD_ATTACHMENT,
  },
];

const INSERT_POSITION_OPTIONS: readonly LabeledOption[] = [
  { label: 'Al principio — lo ultimo publicado se lee arriba', value: 'PREPEND' },
  { label: 'Al final', value: 'APPEND' },
];

/**
 * Bundles ofrecidos, con el guardado incluido aunque no este catalogado.
 *
 * Mismo criterio que el selector de modelos del PROCESADOR_IA: un flujo
 * heredado que apunte a un bundle fuera de la lista NO se vacia en silencio
 * —se conserva y se senala—, porque la lista es de conveniencia y el backend
 * acepta cualquier cadena bien formada.
 */
const bundleOptions = computed<readonly string[]>(() => {
  const { bundle } = store.config;

  return DRUPAL_BUNDLES.includes(bundle) ? DRUPAL_BUNDLES : [bundle, ...DRUPAL_BUNDLES];
});

const isBundleUnlisted = computed<boolean>(() => !DRUPAL_BUNDLES.includes(store.config.bundle));

/** El modo activo lee markup del contexto; `TRANSFER` lo saca del DOM remoto. */
const readsSourceMarkup = computed<boolean>(
  () =>
    store.config.operationMode === DrupalOperationMode.CREATE_NODE ||
    store.config.operationMode === DrupalOperationMode.APPEND_HTML_BLOCK,
);

const isCreateNode = computed<boolean>(
  () => store.config.operationMode === DrupalOperationMode.CREATE_NODE,
);

const isUploadAttachment = computed<boolean>(
  () => store.config.operationMode === DrupalOperationMode.UPLOAD_ATTACHMENT,
);

const isTransfer = computed<boolean>(
  () => store.config.operationMode === DrupalOperationMode.TRANSFER_HTML_BLOCK,
);

/** Todos los modos menos `CREATE_NODE` apuntan a una entidad que ya existe. */
const needsTargetUuid = computed<boolean>(() => !isCreateNode.value);

/** Solo el modo que anade bloque elige donde insertarlos dentro del contenedor. */
const mutatesContainer = computed<boolean>(
  () => store.config.operationMode === DrupalOperationMode.APPEND_HTML_BLOCK,
);

/**
 * Regla de un identificador obligatorio del modo activo.
 *
 * Se extrae al script porque son dos predicados —presencia y formato UUID v4— y
 * en linea quedaba ilegible. El formato se comprueba aqui ademas de en el store
 * para que el mensaje aparezca BAJO el campo y no en la lista de bloqueos.
 */
const requiredUuidRules = [
  (value: string | null): boolean | string =>
    (value ?? '').trim() !== '' || 'Este modo necesita el identificador de la pagina',
  (value: string | null): boolean | string =>
    UUID_V4_PATTERN.test((value ?? '').trim()) || 'No es un UUID v4 valido',
];

const titleRules = [
  (value: string | null): boolean | string =>
    (value ?? '').trim() !== '' || 'Crear contenido exige un titulo',
  (value: string | null): boolean | string =>
    (value ?? '').length <= MAX_DRUPAL_TITLE_LENGTH ||
    `El titulo no puede superar ${MAX_DRUPAL_TITLE_LENGTH} caracteres`,
];

const summaryRules = [
  (value: string | null): boolean | string =>
    (value ?? '').length <= MAX_DRUPAL_SUMMARY_LENGTH ||
    `El resumen no puede superar ${MAX_DRUPAL_SUMMARY_LENGTH} caracteres`,
];

const itemSelectorRules = [
  (value: string | null): boolean | string =>
    (value ?? '').trim() !== '' || 'Hace falta para localizar el bloque que se mueve',
  (value: string | null): boolean | string =>
    (value ?? '').length <= MAX_DRUPAL_SELECTOR_LENGTH ||
    `El selector no puede superar ${MAX_DRUPAL_SELECTOR_LENGTH} caracteres`,
];

const containerSelectorRules = [
  (value: string | null): boolean | string =>
    (value ?? '').length <= MAX_DRUPAL_SELECTOR_LENGTH ||
    `El selector no puede superar ${MAX_DRUPAL_SELECTOR_LENGTH} caracteres`,
];

const attachmentIndexRules = [
  (value: number | null): boolean | string =>
    (value !== null &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= MAX_DRUPAL_ATTACHMENT_INDEX) ||
    `Indice entre 0 y ${MAX_DRUPAL_ATTACHMENT_INDEX}`,
];

/** Normaliza lo tecleado en un campo opcional: vacio significa `null`. */
const toNullableText = (value: string | number | null): string | null => {
  const text = String(value ?? '').trim();

  return text === '' ? null : text;
};
</script>

<template>
  <section class="pd-card q-pa-md" :data-node-id="nodeId">
    <header class="row items-center no-wrap q-gutter-sm q-mb-md">
      <span class="pd-icon-circle">
        <q-icon name="cloud_upload" size="20px" class="pd-node-icon" />
      </span>
      <div>
        <div class="pd-h2">{{ NODE_TYPE_LABELS[NodeType.DESTINO_DRUPAL] }}</div>
        <div class="pd-subtitle">Publica el resultado del flujo en Drupal mediante JSON:API.</div>
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
      <div class="col-12 col-md-7" data-test="operation-mode-field">
        <label class="pd-label" for="drupal-mode">
          Modo de operacion<span class="pd-required">*</span>
        </label>
        <q-select
          id="drupal-mode"
          :model-value="store.config.operationMode"
          :options="MODE_OPTIONS"
          outlined
          dense
          emit-value
          map-options
          class="q-mt-xs"
          :hint="MODE_HINT"
          @update:model-value="store.updateConfig({ operationMode: $event as DrupalOperationMode })"
        />
      </div>

      <div class="col-12 col-md-5" data-test="bundle-field">
        <label class="pd-label" for="drupal-bundle">
          Bundle<span class="pd-required">*</span>
        </label>
        <q-select
          id="drupal-bundle"
          :model-value="store.config.bundle"
          :options="bundleOptions"
          outlined
          dense
          class="q-mt-xs pd-mono"
          :hint="BUNDLE_HINT"
          @update:model-value="store.updateConfig({ bundle: String($event ?? '') })"
        >
          <!-- Un bundle heredado fuera del catalogo se conserva y se senala, en
               vez de vaciarse en silencio al abrir el flujo. -->
          <template v-if="isBundleUnlisted" #after-options>
            <div class="pd-subtitle q-pa-sm">
              El bundle guardado no figura en el catalogo conocido.
            </div>
          </template>
        </q-select>
      </div>
    </div>

    <p class="pd-subtitle q-mt-md q-mb-xs">{{ SANDBOX_NOTICE }}</p>
    <div class="row q-gutter-sm q-mb-sm" data-test="sandbox-presets">
      <!-- Se recorre el catalogo en vez de escribir tres bloques iguales:
           anadir un destino operativo pasa a ser una entrada en
           DRUPAL_SANDBOX_PRESETS y no un cuarto `q-btn` aqui. -->
      <q-btn
        v-for="(preset, key) in DRUPAL_SANDBOX_PRESETS"
        :key="key"
        flat
        dense
        no-caps
        :icon="PRESET_ICONS[key]"
        icon-right="north_east"
        class="pd-preset-btn"
        :label="preset.label"
        :data-test="`preset-${key.toLowerCase()}`"
        @click="onPresetClick(key)"
      >
        <q-tooltip class="pd-preset-tooltip" anchor="bottom left" self="top left">
          <div>{{ preset.description }}</div>
          <div v-if="preset.associatedTemplateName !== null" class="q-mt-xs">
            Plantilla: {{ preset.associatedTemplateName }}
          </div>
        </q-tooltip>
      </q-btn>
    </div>

    <!-- Selectores CERRADOS (Poka-Yoke §4): lo que se ofrece es lo que de
         verdad publica un paso anterior. `TRANSFER_HTML_BLOCK` no aparece
         porque no lee nada del contexto: el bloque sale del DOM remoto. -->
    <template v-if="readsSourceMarkup">
      <h3 class="pd-h2 q-mt-lg q-mb-md">Origen del contenido</h3>

      <div class="row q-col-gutter-md items-start">
        <div class="col-12 col-md-6" data-test="source-namespace-field">
          <label class="pd-label" for="drupal-source-namespace">
            Namespace de origen<span class="pd-required">*</span>
          </label>
          <q-select
            id="drupal-source-namespace"
            :model-value="store.config.sourceNamespace"
            :options="store.namespaceOptions"
            outlined
            dense
            class="q-mt-xs pd-mono"
            :disable="store.namespaceOptions.length === 0"
            :hint="SOURCE_HINT"
            @update:model-value="store.updateConfig({ sourceNamespace: String($event ?? '') })"
          />
        </div>

        <div class="col-12 col-md-6" data-test="source-field-field">
          <label class="pd-label" for="drupal-source-field">
            Campo con el markup<span class="pd-required">*</span>
          </label>
          <q-select
            id="drupal-source-field"
            :model-value="store.config.sourceField"
            :options="store.fieldOptions"
            outlined
            dense
            class="q-mt-xs pd-mono"
            :disable="store.fieldOptions.length === 0"
            @update:model-value="store.updateConfig({ sourceField: String($event ?? '') })"
          />
        </div>
      </div>
    </template>

    <h3 class="pd-h2 q-mt-lg q-mb-md">
      {{ isCreateNode ? 'Contenido a publicar' : 'Pagina de destino' }}
    </h3>

    <div class="row q-col-gutter-md items-start">
      <div v-if="isCreateNode" class="col-12" data-test="title-template-field">
        <label class="pd-label" for="drupal-title">
          Titulo<span class="pd-required">*</span>
        </label>
        <q-input
          id="drupal-title"
          :model-value="store.config.titleTemplate"
          outlined
          dense
          class="q-mt-xs"
          :maxlength="MAX_DRUPAL_TITLE_LENGTH"
          placeholder="{{validated_drupal_json.headline}}"
          hint="Admite marcadores {{namespace.campo}} resueltos contra el contexto del flujo."
          :rules="titleRules"
          @update:model-value="store.updateConfig({ titleTemplate: toNullableText($event) })"
        />
      </div>

      <div v-if="isCreateNode" class="col-12" data-test="summary-template-field">
        <label class="pd-label" for="drupal-summary">Resumen</label>
        <q-input
          id="drupal-summary"
          :model-value="store.config.summaryTemplate"
          outlined
          dense
          type="textarea"
          autogrow
          class="q-mt-xs"
          :maxlength="MAX_DRUPAL_SUMMARY_LENGTH"
          :rules="summaryRules"
          @update:model-value="store.updateConfig({ summaryTemplate: toNullableText($event) })"
        />
      </div>

      <div v-if="needsTargetUuid" class="col-12 col-md-6" data-test="target-uuid-field">
        <label class="pd-label" for="drupal-target-uuid">
          {{ isTransfer ? 'Pagina de origen' : 'Pagina destino' }}
          <span class="pd-required">*</span>
        </label>
        <q-input
          id="drupal-target-uuid"
          :model-value="store.config.targetNodeUuid"
          outlined
          dense
          class="q-mt-xs pd-mono"
          :hint="UUID_HINT"
          :rules="requiredUuidRules"
          @update:model-value="store.updateConfig({ targetNodeUuid: toNullableText($event) })"
        />
      </div>

      <div v-if="isTransfer" class="col-12 col-md-6" data-test="destination-uuid-field">
        <label class="pd-label" for="drupal-destination-uuid">
          Pagina de destino<span class="pd-required">*</span>
        </label>
        <q-input
          id="drupal-destination-uuid"
          :model-value="store.config.destinationNodeUuid"
          outlined
          dense
          class="q-mt-xs pd-mono"
          hint="Se escribe AQUI primero: si fallara despues la retirada del origen, el bloque queda duplicado y no perdido."
          :rules="requiredUuidRules"
          @update:model-value="store.updateConfig({ destinationNodeUuid: toNullableText($event) })"
        />
      </div>

      <div v-if="isTransfer" class="col-12 col-md-6" data-test="item-selector-field">
        <label class="pd-label" for="drupal-item-selector">
          Selector del bloque<span class="pd-required">*</span>
        </label>
        <q-input
          id="drupal-item-selector"
          :model-value="store.config.itemSelector"
          outlined
          dense
          class="q-mt-xs pd-mono"
          placeholder='[data-expediente="S_2026_015"]'
          :maxlength="MAX_DRUPAL_SELECTOR_LENGTH"
          :rules="itemSelectorRules"
          @update:model-value="store.updateConfig({ itemSelector: toNullableText($event) })"
        />
      </div>

      <div v-if="mutatesContainer" class="col-12 col-md-6" data-test="container-selector-field">
        <label class="pd-label" for="drupal-container-selector">Contenedor de bloques</label>
        <q-input
          id="drupal-container-selector"
          :model-value="store.config.containerSelector"
          outlined
          dense
          class="q-mt-xs pd-mono"
          :maxlength="MAX_DRUPAL_SELECTOR_LENGTH"
          hint="Vacio: el bloque se inserta en la raiz del cuerpo de la pagina."
          :rules="containerSelectorRules"
          @update:model-value="store.updateConfig({ containerSelector: toNullableText($event) })"
        />
      </div>

      <div v-if="mutatesContainer" class="col-12 col-md-6" data-test="insert-position-field">
        <label class="pd-label" for="drupal-insert-position">Posicion de insercion</label>
        <q-select
          id="drupal-insert-position"
          :model-value="store.config.insertPosition"
          :options="INSERT_POSITION_OPTIONS"
          outlined
          dense
          emit-value
          map-options
          class="q-mt-xs"
          @update:model-value="
            store.updateConfig({ insertPosition: $event as DrupalInsertPosition })
          "
        />
      </div>
    </div>

    <q-banner
      v-if="isUploadAttachment"
      dense
      class="pd-info-banner q-mt-md"
      data-test="attachment-notice"
    >
      <template #avatar>
        <q-icon name="attach_file" size="20px" class="pd-node-icon" />
      </template>
      <p class="pd-subtitle q-mb-none">{{ ATTACHMENT_NOTICE }}</p>
    </q-banner>

    <!-- Lo que el backend ya resuelve por defecto se recoge en un acordeon: ni
         se esconde (el operador debe poder cambiarlo) ni compite por la
         atencion con los campos que de verdad decide en cada flujo. -->
    <q-expansion-item
      dense
      class="pd-advanced q-mt-lg"
      icon="tune"
      label="Ajustes avanzados"
      data-test="advanced-settings"
    >
      <div class="q-pt-md">
        <p class="pd-subtitle q-mb-md">{{ ADVANCED_NOTICE }}</p>

        <div class="row q-col-gutter-md items-start">
          <div class="col-12 col-md-6" data-test="body-field-name-field">
            <label class="pd-label" for="drupal-body-field">Campo de cuerpo</label>
            <q-input
              id="drupal-body-field"
              :model-value="store.config.bodyFieldName"
              outlined
              dense
              class="q-mt-xs pd-mono"
              @update:model-value="store.updateConfig({ bodyFieldName: String($event ?? '') })"
            />
          </div>

          <div class="col-12 col-md-6" data-test="body-format-field">
            <label class="pd-label" for="drupal-body-format">Formato de texto</label>
            <q-input
              id="drupal-body-format"
              :model-value="store.config.bodyFormat"
              outlined
              dense
              class="q-mt-xs pd-mono"
              @update:model-value="store.updateConfig({ bodyFormat: String($event ?? '') })"
            />
          </div>

          <div class="col-12" data-test="publish-status-field">
            <q-checkbox
              :model-value="store.config.publishStatus"
              label="Publicar al crear"
              class="pd-label"
              @update:model-value="store.updateConfig({ publishStatus: $event === true })"
            />
            <p class="pd-subtitle q-mb-none">
              Desmarcado, el contenido se crea como borrador y alguien debe publicarlo a mano en
              Drupal.
            </p>
          </div>

          <div class="col-12 col-md-4" data-test="attachment-namespace-field">
            <label class="pd-label" for="drupal-attachment-namespace">
              Namespace del adjunto
            </label>
            <q-select
              id="drupal-attachment-namespace"
              :model-value="store.config.attachmentNamespace"
              :options="store.namespaceOptions"
              outlined
              dense
              class="q-mt-xs pd-mono"
              :disable="store.namespaceOptions.length === 0"
              @update:model-value="
                store.updateConfig({ attachmentNamespace: String($event ?? '') })
              "
            />
          </div>

          <div class="col-12 col-md-4" data-test="attachment-field-field">
            <label class="pd-label" for="drupal-attachment-field">Campo del inventario</label>
            <q-select
              id="drupal-attachment-field"
              :model-value="store.config.attachmentField"
              :options="store.attachmentFieldOptions"
              outlined
              dense
              class="q-mt-xs pd-mono"
              :disable="store.attachmentFieldOptions.length === 0"
              @update:model-value="store.updateConfig({ attachmentField: String($event ?? '') })"
            />
          </div>

          <div class="col-12 col-md-4" data-test="attachment-index-field">
            <label class="pd-label" for="drupal-attachment-index">Indice del adjunto</label>
            <q-input
              id="drupal-attachment-index"
              :model-value="store.config.attachmentIndex"
              outlined
              dense
              type="number"
              class="q-mt-xs pd-mono"
              :min="0"
              :max="MAX_DRUPAL_ATTACHMENT_INDEX"
              :rules="attachmentIndexRules"
              @update:model-value="store.updateConfig({ attachmentIndex: Number($event ?? 0) })"
            />
          </div>

          <div class="col-12 col-md-6" data-test="file-field-name-field">
            <label class="pd-label" for="drupal-file-field">Campo de fichero</label>
            <q-input
              id="drupal-file-field"
              :model-value="store.config.fileFieldName"
              outlined
              dense
              class="q-mt-xs pd-mono"
              @update:model-value="store.updateConfig({ fileFieldName: String($event ?? '') })"
            />
          </div>
        </div>
      </div>
    </q-expansion-item>

    <q-banner
      v-for="warning in store.configWarnings"
      :key="warning"
      dense
      class="pd-warn-banner q-mt-md"
      data-test="config-warning"
    >
      <template #avatar>
        <q-icon name="warning_amber" size="20px" class="pd-warn-icon" />
      </template>
      <p class="pd-subtitle q-mb-none">{{ warning }}</p>
    </q-banner>
  </section>
</template>

<style scoped lang="scss">
.pd-node-icon {
  color: var(--pd-primary);
}

.pd-warn-icon {
  color: var(--pd-warning);
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

.pd-preset-btn {
  color: var(--pd-accent-text);
  border: 1px dashed var(--pd-border);
  border-radius: $button-border-radius;
}

// El tooltip de Quasar se monta FUERA del componente (teleport al body), de
// modo que el scope no lo alcanza: de ahi el `:deep`. Usa los tokens del shell
// y no los de superficie porque flota sobre el formulario, igual que el header.
:deep(.pd-preset-tooltip) {
  max-width: 320px;
  background: var(--pd-shell-bg);
  color: var(--pd-shell-text);
  border: 1px solid var(--pd-border);
  border-radius: $generic-border-radius;
  font-size: 12px;
}

.pd-advanced {
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-border);
  border-radius: $generic-border-radius;
}

// Sexta copia del mismo bloque; sigue siendo candidato a subir a app.scss.
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
