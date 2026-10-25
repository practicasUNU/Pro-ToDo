<script setup lang="ts">
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
 */
interface Props {
  rows: readonly KeyValueRow[];
  context: readonly UpstreamNamespace[];
  /** Prefijo de los `data-test` y de los rotulos accesibles. */
  testId: string;
  namePlaceholder?: string;
  valuePlaceholder?: string;
  maxRows: number;
}

const props = withDefaults(defineProps<Props>(), {
  namePlaceholder: 'Nombre',
  valuePlaceholder: 'Valor',
});

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
      <div class="col-12 col-sm-4">
        <q-input
          :model-value="row.name"
          outlined
          dense
          class="pd-mono"
          :placeholder="namePlaceholder"
          :aria-label="`${testId} nombre ${index + 1}`"
          :data-test="`${testId}-name-${index}`"
          @update:model-value="replaceRow(index, { name: String($event ?? '') })"
        />
      </div>
      <div class="col">
        <q-input
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
