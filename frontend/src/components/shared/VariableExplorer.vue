<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { copyToClipboard, useQuasar } from 'quasar';

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
}

const props = withDefaults(defineProps<Props>(), {
  insertLabel: 'Insertar',
  loading: false,
});

const emit = defineEmits<{ insert: [token: string] }>();

const $q = useQuasar();

const selectedNamespace = ref<string | null>(null);
const selectedField = ref<NodeOutputField | null>(null);

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

/** El origen elegido depende de una rama de error. */
const isSelectedConditional = computed<boolean>(
  () =>
    props.context.find(({ namespace }) => namespace === selectedNamespace.value)
      ?.isConditional === true,
);

/** Marcador resultante, o cadena vacia mientras la eleccion este incompleta. */
const interpolatedToken = computed<string>(() =>
  selectedNamespace.value !== null && selectedField.value !== null
    ? `{{${selectedNamespace.value}.${selectedField.value.name}}}`
    : '',
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
        :options="namespaceOptions"
        :loading="loading"
        :disable="loading"
        label="1. Selecciona Origen / Namespace"
        dense
        outlined
        emit-value
        map-options
        class="q-mb-sm"
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

    <!-- Sin `emit-value map-options`, al contrario que el anterior: aqui el
         v-model es el objeto entero, porque la tarjeta necesita `type` y
         `description` ademas del nombre. -->
    <div data-test="variable-field">
      <q-select
        v-model="selectedField"
        :options="availableFields"
        option-label="name"
        label="2. Campo a inyectar"
        dense
        outlined
        :disable="selectedNamespace === null"
      />
    </div>

    <div v-if="selectedField" class="pd-token-card q-mt-sm" data-test="token-detail">
      <div class="pd-mono pd-token-value">{{ interpolatedToken }}</div>
      <div class="row items-center q-gutter-xs q-mt-xs">
        <span class="pd-badge pd-badge--role">{{ selectedField.type }}</span>
        <span v-if="selectedField.description" class="col pd-subtitle q-mb-none">
          {{ selectedField.description }}
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
