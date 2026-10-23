<script setup lang="ts">
import { ref, watch } from 'vue';

import { useTelemetryStore } from '@stores/telemetry.store';

import { toIsoRange } from '@/utils/date-range';

/**
 * Selector del periodo del informe: dos fechas locales y un boton para aplicar.
 *
 * Edita una COPIA local y solo la vuelca al store al aplicar: con un
 * `v-model` directo, cada tecla de la primera fecha dispararia una consulta
 * con un rango a medio escribir. Emite `apply` para que la pagina recargue.
 */
const emit = defineEmits<{ apply: [] }>();

const telemetryStore = useTelemetryStore();

const from = ref(telemetryStore.dateRange.from);
const to = ref(telemetryStore.dateRange.to);

watch(
  () => telemetryStore.dateRange,
  (range) => {
    from.value = range.from;
    to.value = range.to;
  },
);

/** Mensaje de validacion compartido por los dos campos. */
const rangeRule = (): true | string =>
  toIsoRange({ from: from.value, to: to.value }) !== null ||
  'La fecha de inicio debe ser anterior o igual a la de fin.';

const apply = (): void => {
  if (rangeRule() !== true) return;

  telemetryStore.setDateRange({ from: from.value, to: to.value });
  emit('apply');
};
</script>

<template>
  <q-form class="pd-range-filter" aria-label="Periodo del informe" @submit.prevent="apply">
    <q-input
      v-model="from"
      type="date"
      dense
      outlined
      label="Desde"
      stack-label
      :rules="[rangeRule]"
      data-test="range-from"
    />
    <q-input
      v-model="to"
      type="date"
      dense
      outlined
      label="Hasta"
      stack-label
      :rules="[rangeRule]"
      data-test="range-to"
    />
    <q-btn
      type="submit"
      class="pd-btn-secondary"
      flat
      no-caps
      icon="filter_alt"
      label="Aplicar"
      data-test="range-apply"
    />
  </q-form>
</template>

<style scoped lang="scss">
.pd-range-filter {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px;
}
</style>
