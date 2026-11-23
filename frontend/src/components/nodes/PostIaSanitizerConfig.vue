<script setup lang="ts">
import { computed, ref } from 'vue';

import { usePostIaSanitizerStore } from '@stores/nodes/post-ia-sanitizer.store';

import { useSelectFilter } from '@/composables/useSelectFilter';

import { NODE_TYPE_LABELS, NodeType } from '@/types/pipeline';
import {
  ALLOWED_TAG_PRESETS,
  MAX_ALLOWED_TAGS,
  MAX_REQUIRED_SELECTORS,
  MAX_POST_IA_SOURCE_FIELDS,
  MAX_SELECTOR_LENGTH,
  PostIaContentMode,
  SANITIZER_ALLOWED_TAGS,
} from '@/types/nodes/post-ia-sanitizer.types';

import type { AllowedTagPresetKey } from '@/types/nodes/post-ia-sanitizer.types';

interface Props {
  /** Identificador del nodo en el `pipeline_schema` (contrato uniforme §3.1). */
  nodeId: string;
}

const props = defineProps<Props>();

// El store se resuelve POR NODO: un flujo puede encadenar dos escudos —uno tras
// la redaccion y otro tras un reintento con vision— con selectores distintos.
const store = usePostIaSanitizerStore(props.nodeId);

/** Lo que hay escrito en el campo de selector y todavia NO es un chip. */
const typedSelector = ref('');

// Mensajes como constantes: varios los comparten la regla del campo y la ayuda
// bajo el control, y duplicarlos los dejaria divergir.
const SHIELD_NOTICE =
  'Este nodo es la ultima barrera antes de publicar. Poda las vallas markdown que el modelo anade por su cuenta, rechaza los marcadores {{nodo.campo}} que dejo sin resolver, sanea el HTML contra XSS con la misma lista blanca del gestor de plantillas y comprueba que las ranuras estructurales sigan ahi y vengan rellenas.';

const NAMESPACE_HINT =
  'Solo se ofrecen los namespaces que publican los pasos ANTERIORES de este flujo. Si la lista esta vacia, coloca el escudo despues del nodo que produce el marcado.';

const FIELD_HINT =
  'El campo del que se lee el HTML. El PROCESADOR_IA publica filled_markup, y solo lo rellena cuando su instruccion cita una plantilla base.';

const SELECTORS_HINT = `Elige una ranura sugerida o escribe un selector CSS y pulsa Enter. Hasta ${MAX_REQUIRED_SELECTORS}, de ${MAX_SELECTOR_LENGTH} caracteres como mucho.`;

const NO_SUGGESTIONS_HINT =
  'No hay plantilla base en este flujo todavia, asi que no se puede sugerir ninguna ranura. Elige la plantilla en el paso del mapeador, o escribe los selectores a mano.';

const SELECTORS_NOTICE =
  'Si alguno falta, no es un selector valido o queda en blanco, el flujo se detiene en PAUSADO con ERR_POST_IA_DOM_MUTATED. Una ranura cuyo unico contenido sea una imagen, una tabla o un separador cuenta como rellena.';

const TAGS_HINT = `Lista cerrada: solo puede RESTRINGIR lo publicable. Vacio significa la lista blanca completa del saneador, nunca ninguna. Hasta ${MAX_ALLOWED_TAGS}.`;

const TAGS_NOTICE =
  'Pedir una etiqueta que la lista blanca global no admite es ERR_POST_IA_UNSUPPORTED_TAGS: concederla por parametro seria abrir una via de XSS desde la configuracion de un nodo.';

// Selector CERRADO (Poka-Yoke §4): solo los tres modos que el backend admite.
const CONTENT_MODE_OPTIONS = [
  { label: 'Marcado HTML', value: PostIaContentMode.HTML },
  { label: 'Texto (sin plantilla)', value: PostIaContentMode.TEXT },
  {
    label: 'JSON (Validación y serialización de datos estructurados)',
    value: PostIaContentMode.JSON,
  },
] as const;

const JSON_MODE_NOTICE =
  'Modo para flujos que extraen datos (Cerrar licitacion): el escudo valida el objeto entero del PROCESADOR_IA —cadenas, listas y objetos anidados—, le quita toda etiqueta, rechaza los marcadores sin resolver y, si el nodo trae un esquema, comprueba que lo cumple. Un objeto sin ningun dato se detiene con ERR_POST_IA_EMPTY_JSON. El resultado queda en validated_json y, para los campos de texto de primer nivel, en validated_fields.<campo>.';

const TEXT_MODE_NOTICE =
  'Modo para flujos que no maquetan HTML (Cerrar licitacion, Innodays, Innobar): el escudo lee los campos de texto del PROCESADOR_IA, les quita toda etiqueta y rechaza los marcadores sin resolver. No necesita ningun MAPEADOR_PLANTILLA por delante. El resultado queda en validated_fields.<campo>.';

const TEXT_FIELDS_HINT = `Campos de texto del namespace de origen que se auditan. Hasta ${MAX_POST_IA_SOURCE_FIELDS}.`;

/** Opciones del selector de etiquetas, ya ordenadas para que sean localizables. */
const tagOptions = computed<readonly string[]>(() => [...SANITIZER_ALLOWED_TAGS].sort());

// Filtrado predictivo en los tres selectores cerrados del nodo. El de etiquetas
// es MULTIPLE, asi que lleva `use-input` pero NO `fill-input`/`hide-selected`:
// con aquellos los chips de lo ya elegido dejan de pintarse.
const { filteredOptions: filteredNamespaceOptions, filterFn: filterNamespaces } = useSelectFilter(
  () => store.namespaceOptions,
);
const { filteredOptions: filteredFieldOptions, filterFn: filterFields } = useSelectFilter(
  () => store.fieldOptions,
);
const { filteredOptions: filteredTagOptions, filterFn: filterTags } = useSelectFilter(tagOptions);

/** El namespace elegido no figura entre los que ofrece el flujo. */
const isNamespaceUnlisted = computed<boolean>(
  () =>
    store.namespaceOptions.length > 0 &&
    !store.namespaceOptions.includes(store.config.sourceNamespace),
);

/**
 * Regla del campo de selectores. Replica los limites del DTO del backend.
 *
 * Se extrae al script en vez de escribirla en la plantilla porque son dos
 * predicados con interpolacion, y en linea quedaba ilegible.
 */
const selectorRules = [
  (selectors: readonly string[] | null): boolean | string =>
    (selectors ?? []).length <= MAX_REQUIRED_SELECTORS ||
    `No mas de ${MAX_REQUIRED_SELECTORS} selectores`,
  (selectors: readonly string[] | null): boolean | string =>
    (selectors ?? []).every((selector) => selector.length <= MAX_SELECTOR_LENGTH) ||
    `Ningun selector puede superar ${MAX_SELECTOR_LENGTH} caracteres`,
];

/**
 * El autocompletado no tiene nada que aportar.
 *
 * Dos causas distintas y el mismo desenlace: no hay plantilla base de la que
 * leer ranuras, o ya no cabe ninguna mas. Se separan en la ayuda del campo
 * —`NO_SUGGESTIONS_HINT` explica la primera— pero no en el estado del boton.
 */
const canSuggestSelectors = computed<boolean>(
  () =>
    store.detectedSelectorOptions.length > 0 &&
    store.config.requiredSelectors.length < MAX_REQUIRED_SELECTORS,
);

/**
 * Confirma lo tecleado al perder el foco.
 *
 * QSelect solo emite `update:model-value` al confirmar con Enter, asi que sin
 * esto un selector escrito y no confirmado se pierde al pulsar Guardar mientras
 * la pantalla lo sigue mostrando.
 */
const commitTypedSelector = (): void => {
  const selector = typedSelector.value.trim();

  if (selector === '' || store.config.requiredSelectors.includes(selector)) {
    typedSelector.value = '';
    return;
  }

  store.updateConfig({ requiredSelectors: [...store.config.requiredSelectors, selector] });
  typedSelector.value = '';
};
</script>

<template>
  <section class="pd-card q-pa-md" :data-node-id="nodeId">
    <header class="row items-center no-wrap q-gutter-sm q-mb-md">
      <span class="pd-icon-circle">
        <q-icon name="verified_user" size="20px" class="pd-node-icon" />
      </span>
      <div>
        <div class="pd-h2">{{ NODE_TYPE_LABELS[NodeType.ESCUDO_POST_IA] }}</div>
        <div class="pd-subtitle">
          Audita lo que devuelve el modelo antes de que llegue al destino. Nada de lo que no pase
          por aqui deberia publicarse.
        </div>
      </div>
    </header>

    <q-banner dense class="pd-info-banner q-mb-md" data-test="shield-notice">
      <template #avatar>
        <q-icon name="shield" size="20px" class="pd-node-icon" />
      </template>
      <p class="pd-subtitle q-mb-none">{{ SHIELD_NOTICE }}</p>
    </q-banner>

    <div class="q-mb-md" data-test="content-mode-field">
      <span class="pd-label">Que audita el escudo</span>
      <div class="q-mt-xs">
        <q-select
          id="post-ia-content-mode"
          :model-value="store.config.contentMode"
          :options="[...CONTENT_MODE_OPTIONS]"
          outlined
          dense
          emit-value
          map-options
          aria-label="Que audita el escudo"
          data-test="content-mode"
          @update:model-value="store.updateConfig({ contentMode: $event as PostIaContentMode })"
        />
      </div>
      <p v-if="store.isTextMode" class="pd-subtitle q-mt-sm q-mb-none" data-test="text-mode-notice">
        {{ TEXT_MODE_NOTICE }}
      </p>
      <template v-if="store.isJsonMode">
        <p class="pd-subtitle q-mt-sm q-mb-none" data-test="json-mode-notice">
          {{ JSON_MODE_NOTICE }}
        </p>
        <p
          v-if="store.config.jsonSchema !== null"
          class="pd-subtitle q-mt-sm q-mb-none"
          data-test="json-schema-summary"
        >
          Esquema configurado. Campos obligatorios:
          <span class="pd-mono">{{
            store.jsonSchemaRequiredKeys.length > 0
              ? store.jsonSchemaRequiredKeys.join(', ')
              : 'ninguno'
          }}</span>
        </p>
      </template>
    </div>

    <h3 class="pd-h2 q-mt-lg q-mb-md">Origen del marcado</h3>

    <div class="row q-col-gutter-md items-start">
      <!-- Selector CERRADO, no texto libre (Poka-Yoke §4): lo que se ofrece es
           lo que de verdad publica un paso anterior. Un nombre tecleado a mano
           que no exista produce ERR_POST_IA_MISSING_PAYLOAD en ejecucion, con el
           flujo ya PAUSADO. -->
      <div class="col-12 col-md-6" data-test="source-namespace-field">
        <label class="pd-label" for="post-ia-namespace">
          Namespace de origen<span class="pd-required">*</span>
        </label>
        <q-select
          id="post-ia-namespace"
          :model-value="store.config.sourceNamespace"
          :options="filteredNamespaceOptions"
          outlined
          dense
          emit-value
          map-options
          use-input
          fill-input
          hide-selected
          input-debounce="0"
          class="q-mt-xs pd-mono"
          :disable="store.namespaceOptions.length === 0"
          :hint="NAMESPACE_HINT"
          @filter="filterNamespaces"
          :rules="[(val: string) => !!val?.trim() || 'Elige el namespace del que se lee el HTML']"
          @update:model-value="store.updateConfig({ sourceNamespace: String($event ?? '') })"
        />
      </div>

      <!-- Modo TEXT: seleccion MULTIPLE y cerrada de los campos publicados. -->
      <div v-if="store.isTextMode" class="col-12 col-md-6" data-test="source-fields-field">
        <label class="pd-label" for="post-ia-text-fields">
          Campos de texto<span class="pd-required">*</span>
        </label>
        <q-select
          id="post-ia-text-fields"
          :model-value="store.config.sourceFields"
          :options="store.fieldOptions"
          outlined
          dense
          multiple
          use-chips
          class="q-mt-xs pd-mono"
          :max-values="MAX_POST_IA_SOURCE_FIELDS"
          :disable="store.fieldOptions.length === 0"
          :hint="TEXT_FIELDS_HINT"
          :rules="[(val: string[]) => (val ?? []).length > 0 || 'Elige al menos un campo']"
          @update:model-value="store.updateConfig({ sourceFields: [...($event as string[])] })"
        />
      </div>

      <div v-else-if="!store.isJsonMode" class="col-12 col-md-6" data-test="source-field-field">
        <label class="pd-label" for="post-ia-field">
          Campo con el HTML<span class="pd-required">*</span>
        </label>
        <q-select
          id="post-ia-field"
          :model-value="store.config.sourceField"
          :options="filteredFieldOptions"
          outlined
          dense
          emit-value
          map-options
          use-input
          fill-input
          hide-selected
          input-debounce="0"
          class="q-mt-xs pd-mono"
          :disable="store.fieldOptions.length === 0"
          :hint="FIELD_HINT"
          @filter="filterFields"
          :rules="[(val: string) => !!val?.trim() || 'Elige el campo que contiene el marcado']"
          @update:model-value="store.updateConfig({ sourceField: String($event ?? '') })"
        />
      </div>
    </div>

    <!-- Un origen guardado que el flujo ya no produce no se borra en silencio:
         se conserva y se senala, para que el operador decida. -->
    <q-banner
      v-if="isNamespaceUnlisted"
      dense
      class="pd-invalid-banner q-mt-md"
      role="alert"
      data-test="unlisted-namespace"
    >
      <template #avatar>
        <q-icon name="error_outline" size="20px" class="pd-invalid-icon" />
      </template>
      <div class="pd-label pd-invalid-title">
        El namespace guardado ya no lo publica ningun paso anterior
      </div>
      <p class="pd-subtitle pd-mono q-mb-none">{{ store.config.sourceNamespace }}</p>
    </q-banner>
    <!-- Selectores y etiquetas solo tienen sentido sobre marcado HTML. -->
    <template v-if="!store.isTextMode && !store.isJsonMode">
      <br />
      <h3 class="pd-h2 q-mt-lg q-mb-xs">Ranuras que la IA debe respetar</h3>
      <p class="pd-subtitle q-mb-md">{{ SELECTORS_NOTICE }}</p>

      <div data-test="required-selectors-field">
        <div class="row items-center justify-between no-wrap q-gutter-sm">
          <label class="pd-label" for="post-ia-selectors">Selectores estructurales</label>

          <!-- Atajo, no sustituto: rellena de una vez las ranuras que la plantilla
             base declara de verdad. Sin el, el operador tendria que abrir el
             HTML en otra pestana y copiarlas a mano. -->
          <q-btn
            flat
            dense
            no-caps
            icon="auto_fix_high"
            label="Sugerir ranuras de plantilla"
            class="pd-suggest-btn"
            data-test="suggest-selectors"
            :disable="!canSuggestSelectors"
            @click="store.autoPopulateCriticalSelectors()"
          />
        </div>

        <!-- Hibrido a proposito, y es la excepcion consciente al selector CERRADO
           de §4: un selector CSS no pertenece a ninguna lista cerrada conocible
           de antemano —la plantilla puede marcar sus ranuras como quiera—, asi
           que las sugerencias AMPLIAN la entrada manual en vez de sustituirla. -->
        <q-select
          id="post-ia-selectors"
          :model-value="store.config.requiredSelectors"
          :options="store.detectedSelectorOptions"
          outlined
          dense
          multiple
          use-input
          use-chips
          new-value-mode="add-unique"
          input-debounce="0"
          class="q-mt-xs pd-mono"
          placeholder="h1.titular"
          :max-values="MAX_REQUIRED_SELECTORS"
          :hint="store.detectedSelectorOptions.length > 0 ? SELECTORS_HINT : NO_SUGGESTIONS_HINT"
          :rules="selectorRules"
          @update:model-value="store.updateConfig({ requiredSelectors: [...($event as string[])] })"
          @input-value="typedSelector = $event"
          @blur="commitTypedSelector"
        />
      </div>
      <br />
      <h3 class="pd-h2 q-mt-lg q-mb-xs">Etiquetas publicables</h3>
      <p class="pd-subtitle q-mb-md">{{ TAGS_NOTICE }}</p>

      <!-- Selector CERRADO contra la lista blanca real del saneador. Con entrada
         libre, el operador descubriria ERR_POST_IA_UNSUPPORTED_TAGS al guardar
         el flujo entero en vez de al elegir. -->
      <div data-test="allowed-tags-field">
        <label class="pd-label" for="post-ia-tags">Restringir a estas etiquetas</label>

        <!-- Atajos para las formas habituales. Se pintan en bucle: dar de alta
           una mas es anadir una entrada a ALLOWED_TAG_PRESETS, sin tocar esta
           plantilla. -->
        <div class="row q-gutter-sm q-mt-xs q-mb-sm" data-test="allowed-tags-presets">
          <q-btn
            v-for="(preset, key) in ALLOWED_TAG_PRESETS"
            :key="key"
            :label="preset.label"
            outline
            no-caps
            dense
            class="pd-btn-secondary"
            :data-test="`tag-preset-${key.toLowerCase()}`"
            @click="store.applyTagPreset(key as AllowedTagPresetKey)"
          />
        </div>

        <q-select
          id="post-ia-tags"
          :model-value="store.config.allowedTags"
          :options="filteredTagOptions"
          outlined
          dense
          multiple
          use-chips
          use-input
          input-debounce="0"
          class="q-mt-xs pd-mono"
          @filter="filterTags"
          :max-values="MAX_ALLOWED_TAGS"
          :hint="TAGS_HINT"
          @update:model-value="store.updateConfig({ allowedTags: [...($event as string[])] })"
        />
      </div>
    </template>

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

.pd-invalid-icon {
  color: var(--pd-negative);
}

.pd-invalid-title {
  color: var(--pd-negative);
}

.pd-warn-icon {
  color: var(--pd-warning);
}

.pd-suggest-btn {
  color: var(--pd-accent-text);
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

.pd-invalid-banner {
  background: var(--pd-row-urgente);
  border: 1px solid var(--pd-negative);
  border-radius: $generic-border-radius;
  color: var(--pd-text-primary);
}

// Quinta copia del mismo bloque; candidato claro a subir a app.scss.
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
