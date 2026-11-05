<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { copyToClipboard, useQuasar } from 'quasar';

import { useSelectFilter } from '@/composables/useSelectFilter';
import { buildMarker, chipClassFor } from '@/utils/prompt-markers';

import type { NodeOutputField } from '@/types/node-catalog';
import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

/**
 * Explorador determinista de variables (Poka-Yoke).
 *
 * Extraido de `TemplateEditorDialog`, donde nacio, porque el editor de
 * plantillas de prompt necesita exactamente el mismo aparato. Duplicarlo habria
 * dejado dos gramaticas `{{ns.campo}}` que divergirian a la primera correccion.
 *
 * NO decide QUE origenes se ofrecen: los recibe ya filtrados. Cada anfitrion
 * tiene sus propias reglas —la plantilla HTML admite `_assets`, el prompt
 * prohibe los destinos— y meterlas aqui convertiria un componente de
 * presentacion en el juez de dos dominios.
 *
 * Tampoco inserta: emite `insert` y que el anfitrion escriba donde sepa. Uno
 * despacha una transaccion de CodeMirror y el otro manipula el caret de un
 * textarea; no hay contrato comun que valga la pena inventar.
 */
interface Props {
  /** Origenes disponibles, ya filtrados por el anfitrion. */
  context: readonly UpstreamNamespace[];
  /** Rotulo del boton de insercion; cambia entre "plantilla" y "prompt". */
  insertLabel?: string;
  /**
   * El anfitrion todavia esta trayendo los origenes.
   *
   * Distingue "aun no se sabe" de "no hay ninguno", que es lo que el selector
   * vacio no podia decir: quien abria el dialogo y bajaba al desplegable antes
   * de que llegara el catalogo concluia que no habia variables disponibles.
   */
  loading?: boolean;
  /**
   * Muestra el conmutador Obligatorio (*) / Opcional.
   *
   * Solo lo activa el editor de prompts de IA: alli `{{*ns.campo}}` pausa el
   * flujo si el dato falta, sin facturar la inferencia. En una plantilla HTML o
   * en un campo URL toda variable ya es obligatoria y el asterisco no significa
   * nada, asi que ofrecerlo seria invitar a un marcador que el backend rechaza.
   */
  requirednessToggle?: boolean;
}

/** Obligatoriedad del marcador que se va a componer. */
type MarkerRequiredness = 'mandatory' | 'optional';

const props = withDefaults(defineProps<Props>(), {
  insertLabel: 'Insertar',
  loading: false,
  requirednessToggle: false,
});

const emit = defineEmits<{ insert: [token: string] }>();

const $q = useQuasar();

const selectedNamespace = ref<string | null>(null);
/**
 * Nombre del campo elegido, no el objeto entero.
 *
 * Cambio deliberado: con `emit-value` + `option-value="name"` el modelo es la
 * clave que de verdad se interpola (`{{ns.campo}}`), de modo que la etiqueta
 * del desplegable puede enriquecerse con la `description` sin que eso altere el
 * valor. Con el objeto como modelo, `option-label` tenia que ser el nombre a
 * secas o el marcador habria salido mal.
 */
const selectedField = ref<string | null>(null);

/**
 * Por defecto OPCIONAL: es el comportamiento historico del prompt (una
 * ausencia se sustituye por `""`), y marcar algo como obligatorio debe ser una
 * decision explicita del autor.
 */
const requiredness = ref<MarkerRequiredness>('optional');

const REQUIREDNESS_OPTIONS: { label: string; value: MarkerRequiredness }[] = [
  { label: 'Obligatorio (*)', value: 'mandatory' },
  { label: 'Opcional', value: 'optional' },
];

/** Explicacion bajo el conmutador; cambia con la opcion elegida. */
const REQUIREDNESS_HINTS: Record<MarkerRequiredness, string> = {
  mandatory: 'Si el dato falta, el flujo se pausa antes de llamar a la IA (sin coste).',
  optional: 'Si el dato falta, se sustituye por texto vacío y el flujo continúa.',
};

/** Solo se marca como obligatorio si el anfitrion ofrece el conmutador. */
const isMandatory = computed<boolean>(
  () => props.requirednessToggle && requiredness.value === 'mandatory',
);

/** Paso 1 del explorador. El `nodeType` va en la etiqueta, no en el valor. */
const namespaceOptions = computed(() =>
  props.context.map(({ namespace, nodeType, isConditional }) => ({
    label: nodeType === undefined ? namespace : `${namespace} (${nodeType})`,
    value: namespace,
    isConditional: isConditional === true,
  })),
);

/**
 * Aviso de los origenes que solo existen si una rama de error se dispara.
 *
 * Se dice con un badge Y con texto, nunca solo con color: el operador tiene que
 * poder distinguir "este dato siempre llega" de "este dato llega a veces" antes
 * de construir un marcador con el, porque la diferencia no se ve hasta que el
 * flujo se ejecuta y la variable sale vacia.
 */
const CONDITIONAL_HINT =
  'Solo existe si la rama de contingencia se dispara; si no, el marcador resuelve vacio.';

/**
 * Paso 2: campos del origen elegido.
 *
 * Vacio mientras no haya origen, y tambien cuando el origen no declara campos
 * —un tipo sin `outputFields`, o el catalogo aun viajando—. El selector queda
 * entonces sin opciones, que es honesto: no hay nada que ofrecer todavia.
 */
const availableFields = computed<readonly NodeOutputField[]>(
  () => props.context.find(({ namespace }) => namespace === selectedNamespace.value)?.fields ?? [],
);

// Filtrado predictivo en los dos pasos. Un flujo con satelites de contingencia
// llega a ofrecer una docena de origenes, y cada uno hasta siete campos.
const { filteredOptions: filteredNamespaceOptions, filterFn: filterNamespaces } =
  useSelectFilter(namespaceOptions);
const { filteredOptions: filteredFieldOptions, filterFn: filterFields } =
  useSelectFilter(availableFields);

/** El origen elegido depende de una rama de error. */
const isSelectedConditional = computed<boolean>(
  () =>
    props.context.find(({ namespace }) => namespace === selectedNamespace.value)?.isConditional ===
    true,
);

/**
 * Campo elegido, completo.
 *
 * La tarjeta de abajo necesita `type` y `description`, que el modelo ya no
 * lleva. Se resuelve contra `availableFields`, que es la misma lista que
 * alimenta al selector, asi que no puede desincronizarse.
 */
const selectedFieldDetail = computed<NodeOutputField | null>(
  () => availableFields.value.find(({ name }) => name === selectedField.value) ?? null,
);

/** Etiqueta del desplegable: el nombre tecnico y, si la hay, que contiene. */
const fieldLabel = (field: NodeOutputField): string =>
  field.description === undefined || field.description === ''
    ? field.name
    : `${field.name} — ${field.description}`;

/** Marcador resultante, o cadena vacia mientras la eleccion este incompleta. */
const interpolatedToken = computed<string>(() =>
  selectedNamespace.value !== null && selectedField.value !== null
    ? buildMarker(selectedNamespace.value, selectedField.value, isMandatory.value)
    : '',
);

/** Chip de la tarjeta: rojo si es obligatorio, azul si es opcional. */
const tokenChipClass = computed<string>(() =>
  props.requirednessToggle ? chipClassFor(interpolatedToken.value) : '',
);

// Cambiar de origen invalida el campo: pertenecia al anterior, y dejarlo
// compondria un marcador que mezcla dos namespaces.
watch(selectedNamespace, () => {
  selectedField.value = null;
});

/** Devuelve la seleccion al estado inicial; el anfitrion la llama al abrir. */
const reset = (): void => {
  selectedNamespace.value = null;
  selectedField.value = null;
  requiredness.value = 'optional';
};

defineExpose({ reset });

/** Copia el marcador al portapapeles, para pegarlo donde el autor decida. */
const handleCopyToken = async (): Promise<void> => {
  if (interpolatedToken.value === '') return;

  try {
    await copyToClipboard(interpolatedToken.value);
    $q.notify({ type: 'positive', message: 'Marcador copiado al portapapeles' });
  } catch {
    // El portapapeles exige contexto seguro y permiso del navegador. Si lo
    // niega, el marcador sigue a la vista en la tarjeta: se copia a mano.
    $q.notify({
      type: 'warning',
      message: `Copia manualmente: ${interpolatedToken.value}`,
    });
  }
};

const handleInsertToken = (): void => {
  if (interpolatedToken.value === '') return;

  emit('insert', interpolatedToken.value);
};
</script>

<template>
  <!-- Explorador Poka-Yoke: origen y campo se eligen, no se teclean -->
  <div data-test="variable-explorer">
    <div class="pd-label">Variables disponibles</div>
    <p class="pd-subtitle q-mt-xs q-mb-sm">
      Elige el origen y el campo. El marcador se compone solo.
    </p>

    <div data-test="namespace-field">
      <q-select
        v-model="selectedNamespace"
        :options="filteredNamespaceOptions"
        :loading="loading"
        :disable="loading"
        label="1. Selecciona Origen / Namespace"
        dense
        outlined
        emit-value
        map-options
        use-input
        fill-input
        hide-selected
        input-debounce="0"
        class="q-mb-sm"
        @filter="filterNamespaces"
      >
        <template #option="scope">
          <q-item v-bind="scope.itemProps">
            <q-item-section>
              <q-item-label>{{ scope.opt.label }}</q-item-label>
            </q-item-section>
            <q-item-section v-if="scope.opt.isConditional" side>
              <q-badge class="pd-badge" color="warning" data-test="conditional-badge">
                Contingencia
              </q-badge>
            </q-item-section>
          </q-item>
        </template>
      </q-select>

      <!-- El badge solo se ve con el desplegable abierto; este aviso persiste
           junto al campo una vez elegido. -->
      <p
        v-if="isSelectedConditional"
        class="pd-subtitle q-mt-none q-mb-sm"
        data-test="conditional-hint"
      >
        {{ CONDITIONAL_HINT }}
      </p>
    </div>

    <!-- `emit-value map-options` como el anterior: el modelo es la clave que
         se interpola, y la etiqueta queda libre para llevar tambien la
         descripcion. El detalle que pinta la tarjeta se resuelve aparte, en
         `selectedFieldDetail`. -->
    <div data-test="variable-field">
      <q-select
        v-model="selectedField"
        :options="filteredFieldOptions"
        :option-label="fieldLabel"
        option-value="name"
        emit-value
        map-options
        use-input
        fill-input
        hide-selected
        input-debounce="0"
        label="2. Campo a inyectar"
        dense
        outlined
        :disable="selectedNamespace === null"
        @filter="filterFields"
      >
        <!-- El nombre tecnico en `pd-mono` porque es lo que hay que copiar
             caracter a caracter, y la descripcion en texto secundario: el
             operador lee la frase para elegir, pero escribe la clave. -->
        <template #option="{ itemProps, opt }">
          <q-item v-bind="itemProps">
            <q-item-section>
              <q-item-label class="pd-mono">{{ opt.name }}</q-item-label>
              <q-item-label v-if="opt.description" caption class="pd-subtitle">
                {{ opt.description }}
              </q-item-label>
            </q-item-section>
          </q-item>
        </template>
      </q-select>
    </div>

    <!-- Conmutador de obligatoriedad (solo prompts de IA). -->
    <div v-if="props.requirednessToggle" class="q-mt-sm" data-test="requiredness-toggle">
      <q-btn-toggle
        v-model="requiredness"
        :options="REQUIREDNESS_OPTIONS"
        no-caps
        dense
        unelevated
        spread
        toggle-color="primary"
      />
      <p class="pd-subtitle q-mt-xs q-mb-none" data-test="requiredness-hint">
        {{ REQUIREDNESS_HINTS[requiredness] }}
      </p>
    </div>

    <div v-if="selectedFieldDetail" class="pd-token-card q-mt-sm" data-test="token-detail">
      <div class="pd-mono pd-token-value">
        <span :class="tokenChipClass" data-test="token-value">{{ interpolatedToken }}</span>
      </div>
      <div class="row items-center q-gutter-xs q-mt-xs">
        <span class="pd-badge pd-badge--role">{{ selectedFieldDetail.type }}</span>
        <span v-if="selectedFieldDetail.description" class="col pd-subtitle q-mb-none">
          {{ selectedFieldDetail.description }}
        </span>
      </div>
    </div>

    <div class="row q-gutter-sm q-mt-sm">
      <q-btn
        icon="content_copy"
        label="Copiar"
        outline
        no-caps
        dense
        class="pd-btn-secondary"
        data-test="copy-token"
        :disable="!interpolatedToken"
        @click="handleCopyToken"
      />
      <q-btn
        icon="add"
        :label="props.insertLabel"
        no-caps
        dense
        class="pd-btn-primary"
        data-test="insert-token"
        :disable="!interpolatedToken"
        @click="handleInsertToken"
      />
    </div>
  </div>
</template>

<style scoped lang="scss">
// Solo maquetacion: el color proviene de las clases .pd-* globales.
.pd-token-card {
  padding: 8px 12px;
  border: 1px solid var(--pd-border);
  border-radius: 8px;
  background: var(--pd-surface-muted);
}

.pd-token-value {
  color: var(--pd-accent-text);
}
</style>
