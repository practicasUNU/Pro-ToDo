<script setup lang="ts">
import { ref } from 'vue';

import VariableExplorer from '@components/shared/VariableExplorer.vue';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';
import type { KeyValueRow } from '@/types/nodes/http-generic-destination.types';

/**
 * Editor de filas nombre/valor (cabeceras HTTP, parametros de consulta).
 *
 * Componente de PRESENTACION: recibe las filas y emite la lista nueva entera;
 * la validacion vive en el store del nodo, que es quien conoce las reglas del
 * DTO (nombres prohibidos, techo de entradas).
 *
 * Poka-Yoke §4: el valor admite texto fijo (`es`, `application/json`), pero
 * las variables `{{ns.campo}}` se insertan desde el `VariableExplorer`, un
 * selector cerrado alimentado por el contexto real de aguas arriba, nunca
 * tecleadas a mano.
 *
 * Con `namePresets` / `valuePresets` el campo pasa a ser un `q-select` con
 * entrada libre: sugiere los valores habituales sin impedir escribir otro, que
 * es lo que necesita una cabecera propia de cada API. `describeRow` aporta el
 * texto del icono de ayuda de cada fila.
 */
interface Props {
  rows: readonly KeyValueRow[];
  context: readonly UpstreamNamespace[];
  /** Prefijo de los `data-test` y de los rotulos accesibles. */
  testId: string;
  namePlaceholder?: string;
  valuePlaceholder?: string;
  maxRows: number;
  /** Nombres sugeridos; sin ellos el nombre es un `q-input` llano. */
  namePresets?: readonly string[];
  /** Valores sugeridos; sin ellos el valor es un `q-input` llano. */
  valuePresets?: readonly string[];
  /** Texto de ayuda de una fila, o `null` si no hay nada que explicar. */
  describeRow?: (row: KeyValueRow) => string | null;
}

const props = withDefaults(defineProps<Props>(), {
  namePlaceholder: 'Nombre',
  valuePlaceholder: 'Valor',
});

/** Texto que se esta tecleando en cada selector, para filtrar sus sugerencias. */
const nameFilter = ref('');
const valueFilter = ref('');

/** Sugerencias que contienen lo tecleado, sin distinguir mayusculas. */
const filterPresets = (presets: readonly string[], typed: string): string[] => {
  const needle = typed.trim().toLowerCase();
  return presets.filter((preset) => needle === '' || preset.toLowerCase().includes(needle));
};

/** Firma de `@filter` de QSelect: el `update` aplica el filtro de forma diferida. */
const onFilter =
  (target: typeof nameFilter) =>
  (typed: string, update: (callback: () => void) => void): void => {
    update(() => {
      target.value = typed;
    });
  };

const onNameFilter = onFilter(nameFilter);
const onValueFilter = onFilter(valueFilter);

/** Ayuda de la fila, o `null` si el anfitrion no aporta ninguna. */
const helpFor = (row: KeyValueRow): string | null => props.describeRow?.(row) ?? null;

const emit = defineEmits<{ 'update:rows': [rows: KeyValueRow[]] }>();

const replaceRow = (index: number, patch: Partial<KeyValueRow>): void => {
  emit(
    'update:rows',
    props.rows.map((row, position) => (position === index ? { ...row, ...patch } : row)),
  );
};

const addRow = (): void => {
  emit('update:rows', [...props.rows, { name: '', value: '' }]);
};

const removeRow = (index: number): void => {
  emit(
    'update:rows',
    props.rows.filter((_, position) => position !== index),
  );
};

const insertToken = (index: number, token: string): void => {
  replaceRow(index, { value: `${props.rows[index]?.value ?? ''}${token}` });
};
</script>

<template>
  <div class="kv-editor" :data-test="`${testId}-rows`">
    <div
      v-for="(row, index) in rows"
      :key="index"
      class="row q-col-gutter-sm items-start q-mb-sm"
      :data-test="`${testId}-row-${index}`"
    >
      <div class="col-12 col-sm-4 row no-wrap items-center">
        <!-- Entrada libre con sugerencias: `@input-value` mantiene en el store lo
             que se teclea, y `@new-value` acepta el Enter sin exigir una opcion. -->
        <q-select
          v-if="namePresets !== undefined"
          :model-value="row.name"
          :options="filterPresets(namePresets, nameFilter)"
          outlined
          dense
          use-input
          fill-input
          hide-selected
          hide-dropdown-icon
          input-debounce="0"
          class="pd-mono col"
          :placeholder="row.name === '' ? namePlaceholder : undefined"
          :aria-label="`${testId} nombre ${index + 1}`"
          :data-test="`${testId}-name-${index}`"
          @filter="onNameFilter"
          @input-value="replaceRow(index, { name: String($event ?? '') })"
          @new-value="
            (value: string, done: () => void) => (replaceRow(index, { name: value }), done())
          "
          @update:model-value="replaceRow(index, { name: String($event ?? '') })"
        />
        <q-input
          v-else
          :model-value="row.name"
          outlined
          dense
          class="pd-mono col"
          :placeholder="namePlaceholder"
          :aria-label="`${testId} nombre ${index + 1}`"
          :data-test="`${testId}-name-${index}`"
          @update:model-value="replaceRow(index, { name: String($event ?? '') })"
        />
        <q-icon
          v-if="helpFor(row) !== null"
          name="help_outline"
          size="xs"
          class="cursor-pointer q-ml-xs kv-help-icon"
          tabindex="0"
          role="img"
          :aria-label="helpFor(row) ?? undefined"
          :data-test="`${testId}-help-${index}`"
        >
          <q-tooltip max-width="20rem">{{ helpFor(row) }}</q-tooltip>
        </q-icon>
      </div>
      <div class="col">
        <q-select
          v-if="valuePresets !== undefined"
          :model-value="row.value"
          :options="filterPresets(valuePresets, valueFilter)"
          outlined
          dense
          use-input
          fill-input
          hide-selected
          hide-dropdown-icon
          input-debounce="0"
          class="pd-mono"
          :placeholder="row.value === '' ? valuePlaceholder : undefined"
          :aria-label="`${testId} valor ${index + 1}`"
          :data-test="`${testId}-value-${index}`"
          @filter="onValueFilter"
          @input-value="replaceRow(index, { value: String($event ?? '') })"
          @new-value="(value: string, done: () => void) => (replaceRow(index, { value }), done())"
          @update:model-value="replaceRow(index, { value: String($event ?? '') })"
        >
          <template #append>
            <q-btn
              flat
              dense
              round
              size="sm"
              icon="data_object"
              :aria-label="`Insertar variable en ${testId} ${index + 1}`"
              @click.stop
            >
              <q-tooltip>Insertar una variable del contexto</q-tooltip>
              <q-menu anchor="bottom right" self="top right" class="pd-card q-pa-md">
                <VariableExplorer
                  :context="context"
                  insert-label="Insertar"
                  @insert="insertToken(index, $event)"
                />
              </q-menu>
            </q-btn>
          </template>
        </q-select>
        <q-input
          v-else
          :model-value="row.value"
          outlined
          dense
          class="pd-mono"
          :placeholder="valuePlaceholder"
          :aria-label="`${testId} valor ${index + 1}`"
          :data-test="`${testId}-value-${index}`"
          @update:model-value="replaceRow(index, { value: String($event ?? '') })"
        >
          <template #append>
            <q-btn
              flat
              dense
              round
              size="sm"
              icon="data_object"
              :aria-label="`Insertar variable en ${testId} ${index + 1}`"
            >
              <q-tooltip>Insertar una variable del contexto</q-tooltip>
              <q-menu anchor="bottom right" self="top right" class="pd-card q-pa-md">
                <VariableExplorer
                  :context="context"
                  insert-label="Insertar"
                  @insert="insertToken(index, $event)"
                />
              </q-menu>
            </q-btn>
          </template>
        </q-input>
      </div>
      <div class="col-auto">
        <q-btn
          class="pd-btn-icon pd-btn-icon--danger"
          outline
          dense
          size="sm"
          icon="delete_outline"
          :aria-label="`Quitar ${testId} ${index + 1}`"
          :data-test="`${testId}-remove-${index}`"
          @click="removeRow(index)"
        />
      </div>
    </div>

    <q-btn
      flat
      dense
      no-caps
      icon="add"
      class="kv-add-btn"
      :label="`Anadir (${rows.length}/${maxRows})`"
      :disable="rows.length >= maxRows"
      :data-test="`${testId}-add`"
      @click="addRow"
    />
  </div>
</template>

<style scoped lang="scss">
.kv-help-icon {
  color: var(--pd-accent-text);
}

.kv-add-btn {
  color: var(--pd-accent-text);
  border: 1px dashed var(--pd-border);
  border-radius: $button-border-radius;
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
</style>
