<script setup lang="ts">
import { useQuasar } from 'quasar';
import { computed, inject, watch } from 'vue';

import { useDrupalHttpStore } from '@stores/nodes/drupal-http.store';

import { NODE_SANDBOX_MODE_KEY } from '@components/nodes/node-sandbox-mode';

import { useSelectFilter } from '@/composables/useSelectFilter';

import { NODE_TYPE_LABELS, NodeType } from '@/types/pipeline';
import {
  DRUPAL_BUNDLES,
  DRUPAL_PRESETS,
  DrupalOperationMode,
  MAX_DRUPAL_ATTACHMENT_INDEX,
  MAX_DRUPAL_LINK_TEMPLATE_LENGTH,
  MAX_DRUPAL_SELECTOR_LENGTH,
  MAX_DRUPAL_SUMMARY_LENGTH,
  MAX_DRUPAL_TITLE_LENGTH,
  UUID_V4_PATTERN,
  describePresetLabel,
  toDrupalEnvironment,
} from '@/types/nodes/drupal-http.types';
import { blockNonNumericKeys } from '@/utils/numeric-input';

import type {
  DrupalInsertPosition,
  DrupalLinkAttribute,
  DrupalPresetKey,
} from '@/types/nodes/drupal-http.types';

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
 * El formulario esta montado dentro del Banco de Pruebas.
 *
 * Alli el nodo solo puede apuntar a las paginas de pruebas: el toggle se fuerza
 * a Sandbox y se deshabilita. Es la mitad VISIBLE de la garantia; la que manda
 * es la del backend (`NodeSandboxService`), que rechaza cualquier pagina fuera
 * de la lista blanca aunque el cliente la mande.
 */
const sandboxLocked = inject(NODE_SANDBOX_MODE_KEY, false);

watch(
  () => store.config.isSandbox,
  (isSandbox) => {
    if (sandboxLocked && !isSandbox) store.setSandbox(true);
  },
  { immediate: true },
);

/**
 * Carga un destino y lo confirma por `q-notify`.
 *
 * El acuse importa: un preset escribe siete campos repartidos por secciones que
 * pueden estar plegadas, de modo que sin aviso el unico indicio visible de que
 * el boton hizo algo seria el UUID. Los presets cuya pagina no tiene UUID
 * conocido en este entorno dejan ademas un campo obligatorio vacio A PROPOSITO,
 * y el aviso lo dice —con la ruta— para que no se lea como un fallo del boton.
 */
const onPresetClick = (presetKey: DrupalPresetKey): void => {
  store.applyPreset(presetKey);

  const preset = DRUPAL_PRESETS[presetKey];
  const target = preset.environments[toDrupalEnvironment(store.config.isSandbox)];
  const needsPage =
    preset.operationMode !== DrupalOperationMode.CREATE_NODE &&
    (target.targetNodeUuid === null ||
      (preset.operationMode === DrupalOperationMode.TRANSFER_HTML_BLOCK &&
        target.destinationNodeUuid === null));

  $q.notify({
    type: needsPage ? 'warning' : 'positive',
    message: needsPage
      ? `${describePresetLabel(preset, store.config.isSandbox)}: ${MANUAL_PAGE_NOTICE} (${target.path}).`
      : 'Preset cargado exitosamente',
    timeout: needsPage ? 6000 : 2000,
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
  'Identificador del tipo de contenido en Drupal (ej: node--page para paginas generales o agregadoras, node--noticias para publicaciones individuales de Notiweb). Es el `data.type` de JSON:API, en la forma entidad--bundle, y de el se deriva la ruta de coleccion.';

/**
 * Icono de cada destino operativo.
 *
 * Vive aqui y no en el catalogo de tipos porque es decision de PRESENTACION:
 * `DRUPAL_PRESETS` describe una configuracion de Drupal y no deberia
 * saber que existe Material Icons. El `Record` es completo, de modo que anadir
 * un preset sin icono no compila.
 */
const PRESET_ICONS: Readonly<Record<DrupalPresetKey, string>> = {
  ABRIR_LICITACION: 'post_add',
  CERRAR_LICITACION: 'archive',
  VERIFICACION_TITULOS: 'school',
  INNODAYS: 'link',
  NOTIWEB: 'newspaper',
};

const PRESETS_NOTICE =
  'Destinos del portal en el entorno elegido arriba. Cada uno rellena pagina, bundle, modo y selectores a la vez: por separado no significan nada.';

const ENVIRONMENT_HINT =
  'Activado, los destinos rapidos apuntan a las paginas de pruebas del portal. Desactivado, a las paginas publicas.';

/** Por que el toggle no se puede mover en el Banco de Pruebas. */
const SANDBOX_LOCK_NOTICE =
  'En el Banco de Pruebas solo está permitido ejecutar sobre el entorno Sandbox';

/**
 * Por que un preset deja la pagina pendiente.
 *
 * Sin este aviso el operador lee el asterisco del UUID como un fallo del preset
 * y vuelve a pulsarlo. Esas paginas no tienen UUID confirmado, y apuntarlas a
 * otra «para probar» puede ser destructivo (ver `DrupalPresetTarget`).
 */
const MANUAL_PAGE_NOTICE =
  'indica a mano el UUID de la pagina, que no esta confirmado, antes de poder guardar';

const LINK_NOTICE =
  'Modo enlace: se lee la pagina, se cambia SOLO el atributo del elemento elegido y se guarda. El resto del HTML, los estilos y los scripts no se tocan. El selector debe encontrar exactamente un elemento.';

const LINK_ATTRIBUTE_OPTIONS: readonly { label: string; value: DrupalLinkAttribute }[] = [
  { label: 'href — destino de un enlace', value: 'href' },
  { label: 'src — origen de una imagen', value: 'src' },
];

const SOURCE_HINT =
  'Solo se ofrecen los namespaces que publican los pasos ANTERIORES de este flujo. Elegir uno que nadie produzca rechaza el guardado con ERR_MISSING_UPSTREAM_CONTEXT.';

const UUID_HINT = 'UUID v4 de la entidad en Drupal. Usa los botones de sandbox para no teclearlo.';

const AGGREGATOR_NOTICE =
  'Modo agregador activo: el contenido se inserta directamente en el HTML de la pagina objetivo mediante manipulacion del DOM. No requiere titulo ni resumen de entidad independientes.';

/**
 * Explicacion del reparto por universidad, y va APARTE de `AGGREGATOR_NOTICE`.
 *
 * Aquel se muestra con `mutatesRemoteDom`, que cubre tambien el traslado de
 * bloques, y el despacho jerarquico solo existe en el modo agregador. Fundir
 * los dos textos mentiria en TRANSFER_HTML_BLOCK, de modo que este va gobernado
 * por `mutatesContainer`, que es el computed APPEND-only.
 */
const HIERARCHICAL_DISPATCH_NOTICE =
  'Despacho jerarquico: cuando el marcado trae paneles de acordeon, cada uno se inyecta dentro del sub-acordeon de su universidad (#accordion mas las siglas) segun su data-parent. Si algun panel no encuentra su contenedor en la pagina, no se publica ninguno y el nodo se detiene, para que ningun comite termine fuera de lugar.';

/**
 * Que hace el contenedor de bloques DESDE el despacho jerarquico.
 *
 * Deja de ser el destino unico: los paneles de acordeon van cada uno al suyo.
 * Lo que sigue cayendo aqui es el marcado que NO viene en paneles, que es el de
 * los otros canales que publican por este modo —licitaciones, Notiweb—.
 */
const CONTAINER_SELECTOR_HINT =
  'Destino del marcado que NO viene en paneles de acordeon. Vacio: la raiz del cuerpo de la pagina.';

const ATTACHMENT_NOTICE =
  'El binario sale del inventario de adjuntos del correo. El motor libera esos bytes en cuanto un nodo publica texto, asi que este paso debe ir ANTES del parser.';

const ADVANCED_NOTICE =
  'Valores que el backend ya resuelve por defecto. Tocalos solo si este Drupal se aparta de la instalacion estandar.';

/**
 * Etiquetas de los cuatro modos, en el orden en que se suelen elegir.
 *
 * Cada una nombra los CANALES institucionales que la usan, y no solo la
 * operacion tecnica: quien configura el nodo piensa en "verificador de titulos",
 * no en "APPEND_HTML_BLOCK". Citar los dos canales que comparten el modo
 * agregador es lo que evita que alguien elija "crear contenido" para los
 * paneles de acreditacion, que es el error que deja el flujo publicando
 * entidades sueltas que nadie alcanza desde la pagina que las agrega.
 *
 * La de UPLOAD_ATTACHMENT NO cita un nombre de campo concreto: `fileFieldName`
 * es configurable y la estrategia ademas autodetecta el campo probando
 * candidatos, de modo que prometer uno aqui seria una promesa que el formulario
 * no cumple.
 */
const MODE_OPTIONS: readonly LabeledOption[] = [
  {
    label: 'Crear contenido nuevo (Notiweb / articulo independiente)',
    value: DrupalOperationMode.CREATE_NODE,
  },
  {
    label: 'Insertar bloque en pagina agregadora (licitaciones abiertas / verificador de titulos)',
    value: DrupalOperationMode.APPEND_HTML_BLOCK,
  },
  {
    label: 'Mover bloque entre paginas (cerrar licitacion hacia historico)',
    value: DrupalOperationMode.TRANSFER_HTML_BLOCK,
  },
  {
    label: 'Actualizar el enlace o la imagen de un elemento (Innodays)',
    value: DrupalOperationMode.UPDATE_LINK_SOURCE,
  },
  {
    label: 'Subir un adjunto del correo como fichero fisico',
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

// Filtrado predictivo de las cinco listas que crecen con el contenido: los
// bundles del sitio, los namespaces que publican los nodos de delante y sus
// campos. Los dos desplegables de adjuntos llevan instancia PROPIA aunque se
// alimenten de la misma fuente: comparten el filtro y teclear en uno recortaria
// las opciones del otro.
const { filteredOptions: filteredBundleOptions, filterFn: filterBundles } =
  useSelectFilter(bundleOptions);
const { filteredOptions: filteredNamespaceOptions, filterFn: filterNamespaces } = useSelectFilter(
  () => store.namespaceOptions,
);
const {
  filteredOptions: filteredAttachmentNamespaceOptions,
  filterFn: filterAttachmentNamespaces,
} = useSelectFilter(() => store.namespaceOptions);
const { filteredOptions: filteredFieldOptions, filterFn: filterFields } = useSelectFilter(
  () => store.fieldOptions,
);
const { filteredOptions: filteredAttachmentFieldOptions, filterFn: filterAttachmentFields } =
  useSelectFilter(() => store.attachmentFieldOptions);

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

const isLinkUpdate = computed<boolean>(
  () => store.config.operationMode === DrupalOperationMode.UPDATE_LINK_SOURCE,
);

/** Todos los modos menos `CREATE_NODE` apuntan a una entidad que ya existe. */
const needsTargetUuid = computed<boolean>(() => !isCreateNode.value);

/**
 * El modo activo MUTA el DOM de una pagina que ya existe.
 *
 * Es el espejo en cliente del `touchesDom` que `DrupalHttpStrategy` usa en
 * `getUnreachableErrorCodes` para decidir que modos pueden fallar por un
 * selector, y se nombra parecido a proposito: son el mismo concepto a los dos
 * lados de la red.
 *
 * NO es `!isCreateNode`: `UPLOAD_ATTACHMENT` tampoco crea contenido, pero sube
 * un binario a un campo de la entidad sin tocar su marcado. Meterlo aqui
 * prometeria al operador una insercion en el HTML que ese modo no hace.
 */
const mutatesRemoteDom = computed<boolean>(() => mutatesContainer.value || isTransfer.value);

/** Solo el modo que anade bloque elige donde insertarlos dentro del contenedor. */
const mutatesContainer = computed<boolean>(
  () => store.config.operationMode === DrupalOperationMode.APPEND_HTML_BLOCK,
);

/**
 * El APPEND que ademas sube el adjunto de paso.
 *
 * Es su propia bandera y no el modo, porque la regla 11 del validador obliga a
 * que todo DESTINO cierre el flujo: no se puede encadenar un UPLOAD_ATTACHMENT
 * delante, asi que subir y publicar tienen que caber en el mismo nodo.
 */
const uploadsWithinAppend = computed<boolean>(
  () => mutatesContainer.value && store.config.uploadAttachment,
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

const linkSelectorRules = [
  (value: string | null): boolean | string =>
    (value ?? '').trim() !== '' || 'Hace falta para localizar el elemento',
  (value: string | null): boolean | string =>
    (value ?? '').length <= MAX_DRUPAL_SELECTOR_LENGTH ||
    `El selector no puede superar ${MAX_DRUPAL_SELECTOR_LENGTH} caracteres`,
];

const linkValueRules = [
  (value: string | null): boolean | string =>
    (value ?? '').trim() !== '' || 'Hace falta el nuevo valor del enlace',
  (value: string | null): boolean | string =>
    (value ?? '').length <= MAX_DRUPAL_LINK_TEMPLATE_LENGTH ||
    `El valor no puede superar ${MAX_DRUPAL_LINK_TEMPLATE_LENGTH} caracteres`,
];

const containerSelectorRules = [
  (value: string | null): boolean | string =>
    (value ?? '').length <= MAX_DRUPAL_SELECTOR_LENGTH ||
    `El selector no puede superar ${MAX_DRUPAL_SELECTOR_LENGTH} caracteres`,
];

const attachmentListSelectorRules = [
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

    <div class="q-mb-md" data-test="environment-field">
      <q-toggle
        :model-value="store.config.isSandbox"
        label="Usar entorno de pruebas (Sandbox)"
        :disable="sandboxLocked"
        data-test="environment-toggle"
        @update:model-value="store.setSandbox($event)"
      />
      <p v-if="sandboxLocked" class="pd-subtitle q-mb-none" data-test="sandbox-lock-notice">
        <q-icon name="lock" size="16px" class="q-mr-xs" />{{ SANDBOX_LOCK_NOTICE }}
      </p>
      <p v-else class="pd-subtitle q-mb-none">{{ ENVIRONMENT_HINT }}</p>
    </div>

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
          Tipo de contenido en Drupal (Bundle)<span class="pd-required">*</span>
          <q-icon name="help_outline" size="15px" class="q-ml-xs pd-hint-icon">
            <q-tooltip max-width="320px">{{ BUNDLE_HINT }}</q-tooltip>
          </q-icon>
        </label>
        <q-select
          id="drupal-bundle"
          :model-value="store.config.bundle"
          :options="filteredBundleOptions"
          outlined
          dense
          use-input
          fill-input
          hide-selected
          input-debounce="0"
          class="q-mt-xs pd-mono"
          :hint="BUNDLE_HINT"
          @filter="filterBundles"
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

    <p class="pd-subtitle q-mt-md q-mb-xs">{{ PRESETS_NOTICE }}</p>
    <div class="row q-gutter-sm q-mb-sm" data-test="sandbox-presets">
      <!-- Se recorre el catalogo en vez de escribir cinco bloques iguales: el
           orden de los botones es el de DRUPAL_PRESETS, y anadir un destino
           operativo pasa a ser una entrada alli y no un `q-btn` mas aqui. -->
      <q-btn
        v-for="(preset, key) in DRUPAL_PRESETS"
        :key="key"
        flat
        dense
        no-caps
        :icon="PRESET_ICONS[key]"
        icon-right="north_east"
        class="pd-preset-btn"
        :label="describePresetLabel(preset, store.config.isSandbox)"
        :data-test="`preset-${key.toLowerCase()}`"
        @click="onPresetClick(key)"
      >
        <q-tooltip class="pd-preset-tooltip" anchor="bottom left" self="top left">
          <div>{{ preset.description }}</div>
          <div class="q-mt-xs pd-mono">
            {{ preset.environments[toDrupalEnvironment(store.config.isSandbox)].path }}
          </div>
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
            :options="filteredNamespaceOptions"
            outlined
            dense
            use-input
            fill-input
            hide-selected
            input-debounce="0"
            class="q-mt-xs pd-mono"
            :disable="store.namespaceOptions.length === 0"
            :hint="SOURCE_HINT"
            @filter="filterNamespaces"
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
            :options="filteredFieldOptions"
            outlined
            dense
            use-input
            fill-input
            hide-selected
            input-debounce="0"
            class="q-mt-xs pd-mono"
            :disable="store.fieldOptions.length === 0"
            @filter="filterFields"
            @update:model-value="store.updateConfig({ sourceField: String($event ?? '') })"
          />
        </div>
      </div>
    </template>

    <h3 class="pd-h2 q-mt-lg q-mb-md">
      {{ isCreateNode ? 'Contenido a publicar' : 'Pagina de destino' }}
    </h3>

    <!-- Ocupa el hueco que dejan el titulo y el resumen al desaparecer. Sin el,
         el operador ve dos campos esfumarse al cambiar de modo y nada que
         explique por que ya no hacen falta. -->
    <q-banner
      v-if="mutatesRemoteDom"
      dense
      class="pd-info-banner q-mb-md"
      data-test="aggregator-notice"
    >
      <template #avatar>
        <q-icon name="account_tree" size="20px" class="pd-node-icon" />
      </template>
      <p class="pd-subtitle q-mb-none">{{ AGGREGATOR_NOTICE }}</p>
    </q-banner>

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

      <div v-if="isLinkUpdate" class="col-12">
        <q-banner dense class="pd-info-banner q-mb-sm" data-test="link-notice">
          <template #avatar>
            <q-icon name="link" size="20px" class="pd-node-icon" />
          </template>
          <p class="pd-subtitle q-mb-none">{{ LINK_NOTICE }}</p>
        </q-banner>
      </div>

      <div v-if="isLinkUpdate" class="col-12 col-md-8" data-test="link-selector-field">
        <label class="pd-label" for="drupal-link-selector">
          Elemento a actualizar (Selector CSS)<span class="pd-required">*</span>
        </label>
        <q-input
          id="drupal-link-selector"
          :model-value="store.config.linkSelector"
          outlined
          dense
          class="q-mt-xs pd-mono"
          placeholder="table tr:contains('Agrifood') a"
          :maxlength="MAX_DRUPAL_SELECTOR_LENGTH"
          :rules="linkSelectorRules"
          @update:model-value="store.updateConfig({ linkSelector: toNullableText($event) })"
        />
      </div>

      <div v-if="isLinkUpdate" class="col-12 col-md-4" data-test="link-attribute-field">
        <label class="pd-label" for="drupal-link-attribute">
          Atributo<span class="pd-required">*</span>
        </label>
        <q-select
          id="drupal-link-attribute"
          :model-value="store.config.linkAttribute"
          :options="LINK_ATTRIBUTE_OPTIONS"
          outlined
          dense
          emit-value
          map-options
          class="q-mt-xs"
          @update:model-value="store.updateConfig({ linkAttribute: $event as DrupalLinkAttribute })"
        />
      </div>

      <div v-if="isLinkUpdate" class="col-12" data-test="link-value-field">
        <label class="pd-label" for="drupal-link-value">
          Nuevo valor<span class="pd-required">*</span>
        </label>
        <q-input
          id="drupal-link-value"
          :model-value="store.config.linkValueTemplate"
          outlined
          dense
          class="q-mt-xs pd-mono"
          placeholder="{{llm_response.url}}"
          hint="Admite marcadores {{namespace.campo}}. Solo rutas relativas y http(s); un javascript: o un data: se rechazan al ejecutar."
          :maxlength="MAX_DRUPAL_LINK_TEMPLATE_LENGTH"
          :rules="linkValueRules"
          @update:model-value="store.updateConfig({ linkValueTemplate: toNullableText($event) })"
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

      <!-- Va pegado al campo de abajo y no arriba del todo porque es SU
           explicacion: sin el, "Contenedor de bloques" se lee como el unico
           destino, que es lo que dejo de ser cuando llego el reparto por
           universidad. -->
      <div v-if="mutatesContainer" class="col-12">
        <q-banner dense class="pd-info-banner q-mb-sm" data-test="hierarchical-dispatch-notice">
          <template #avatar>
            <q-icon name="account_tree" size="20px" class="pd-node-icon" />
          </template>
          <p class="pd-subtitle q-mb-none">{{ HIERARCHICAL_DISPATCH_NOTICE }}</p>
        </q-banner>
      </div>

      <div v-if="mutatesContainer" class="col-12 col-md-6" data-test="container-selector-field">
        <!-- SIN asterisco: el campo no es obligatorio. `REQUIRED_PARAMS_BY_MODE`
             solo exige `targetNodeUuid` en este modo, y con el campo vacio el
             backend inserta en la raiz del fragmento. -->
        <label class="pd-label" for="drupal-container-selector">
          Contenedor de bloques sin panel (Selector CSS)
        </label>
        <q-input
          id="drupal-container-selector"
          :model-value="store.config.containerSelector"
          outlined
          dense
          class="q-mt-xs pd-mono"
          :maxlength="MAX_DRUPAL_SELECTOR_LENGTH"
          placeholder="#accordion"
          :hint="CONTAINER_SELECTOR_HINT"
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
              :options="filteredAttachmentNamespaceOptions"
              outlined
              dense
              use-input
              fill-input
              hide-selected
              input-debounce="0"
              class="q-mt-xs pd-mono"
              :disable="store.namespaceOptions.length === 0"
              @filter="filterAttachmentNamespaces"
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
              :options="filteredAttachmentFieldOptions"
              outlined
              dense
              use-input
              fill-input
              hide-selected
              input-debounce="0"
              class="q-mt-xs pd-mono"
              :disable="store.attachmentFieldOptions.length === 0"
              @filter="filterAttachmentFields"
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
              @keydown="blockNonNumericKeys"
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

          <div v-if="mutatesContainer" class="col-12" data-test="upload-attachment-field">
            <q-checkbox
              :model-value="store.config.uploadAttachment"
              label="Subir el adjunto y enlazarlo en el bloque"
              class="pd-label"
              @update:model-value="store.updateConfig({ uploadAttachment: $event === true })"
            />
            <p class="pd-subtitle q-mb-none">
              El binario solo sobrevive hasta aqui si el PARSER_PRE_IA de delante tiene activado
              «omitir extraccion de documentos». Si no lo encuentra, el bloque se publica igual, sin
              enlace.
            </p>
          </div>

          <div
            v-if="uploadsWithinAppend"
            class="col-12 col-md-6"
            data-test="attachment-list-selector-field"
          >
            <label class="pd-label" for="drupal-attachment-list-selector">
              Lista de pliegos del bloque
            </label>
            <q-input
              id="drupal-attachment-list-selector"
              :model-value="store.config.attachmentListSelector"
              outlined
              dense
              class="q-mt-xs pd-mono"
              :maxlength="MAX_DRUPAL_SELECTOR_LENGTH"
              hint="Selector DENTRO del bloque que se inserta, no de la pagina agregadora."
              :rules="attachmentListSelectorRules"
              @update:model-value="
                store.updateConfig({ attachmentListSelector: String($event ?? '') })
              "
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
// Solo maquetacion: el color proviene de los tokens --pd-*.
.pd-hint-icon {
  color: var(--pd-text-secondary);
}

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
  font-size: 0.75rem;
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
