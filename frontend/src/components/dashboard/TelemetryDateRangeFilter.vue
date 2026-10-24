<script setup lang="ts">
import { ref, watch } from 'vue';

import { useTelemetryStore } from '@stores/telemetry.store';

import {
  datePickerBounds,
  defaultDateRange,
  isFutureDate,
  toIsoRange,
} from '@/utils/date-range';

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
/**
 * Dias elegibles en el calendario: ni futuros ni mas antiguos que el historial.
 *
 * `q-date` entrega la fecha en su formato de barras, que es justo el que
 * devuelve `datePickerBounds`, asi que la comparacion es textual y no necesita
 * construir ningun `Date`.
 */
const { min: MIN_DATE, max: MAX_DATE } = datePickerBounds();

const isSelectableDate = (date: string): boolean => date >= MIN_DATE && date <= MAX_DATE;

/**
 * Mensaje de validacion compartido por los dos campos.
 *
 * Comprueba el futuro APARTE del rango invertido porque son dos errores
 * distintos y el operador necesita saber cual cometio. `q-date` ya impide
 * elegir manana con el raton, pero el campo se puede teclear y pegar.
 */
const rangeRule = (): true | string => {
  if (isFutureDate(from.value) || isFutureDate(to.value)) {
    return 'No se pueden consultar fechas futuras.';
  }

  return (
    toIsoRange({ from: from.value, to: to.value }) !== null ||
    'La fecha de inicio debe ser anterior o igual a la de fin.'
  );
};

const apply = (): void => {
  if (rangeRule() !== true) return;

  telemetryStore.setDateRange({ from: from.value, to: to.value });
  emit('apply');
};

/**
 * Devuelve el periodo al de partida y recarga.
 *
 * Reutiliza `defaultDateRange()` en vez de vaciar los campos: el informe no
 * admite un rango abierto —el backend exige las dos fechas— y dejarlos en
 * blanco daria un formulario invalido en lugar de una vista limpia.
 */
const clear = (): void => {
  const range = defaultDateRange();

  from.value = range.from;
  to.value = range.to;
  telemetryStore.setDateRange(range);
  emit('apply');
};
</script>

<template>
  <q-form class="pd-range-filter" aria-label="Periodo del informe" @submit.prevent="apply">
    <!--
      `q-date` en un popup y no `type="date"`: aquel abre el selector NATIVO del
      navegador, que se pinta con el tema del sistema operativo y no admite CSS,
      de modo que en modo oscuro aparecia un recuadro blanco en mitad del panel.
      El campo sigue siendo de texto en formato ISO, asi que el `v-model` y los
      `data-test` no cambian.
    -->
    <q-input
      v-model="from"
      dense
      outlined
      label="Desde"
      stack-label
      mask="####-##-##"
      :rules="[rangeRule]"
      data-test="range-from"
    >
      <template #append>
        <q-icon name="event" class="cursor-pointer">
          <q-popup-proxy cover transition-show="scale" transition-hide="scale">
            <q-date
                  v-model="from"
                  mask="YYYY-MM-DD"
                  class="pd-date-popup"
                  :options="isSelectableDate"
                >
              <div class="row items-center justify-end">
                <q-btn v-close-popup flat no-caps label="Cerrar" class="pd-btn-secondary" />
              </div>
            </q-date>
          </q-popup-proxy>
        </q-icon>
      </template>
    </q-input>
    <q-input
      v-model="to"
      dense
      outlined
      label="Hasta"
      stack-label
      mask="####-##-##"
      :rules="[rangeRule]"
      data-test="range-to"
    >
      <template #append>
        <q-icon name="event" class="cursor-pointer">
          <q-popup-proxy cover transition-show="scale" transition-hide="scale">
            <q-date
                  v-model="to"
                  mask="YYYY-MM-DD"
                  class="pd-date-popup"
                  :options="isSelectableDate"
                >
              <div class="row items-center justify-end">
                <q-btn v-close-popup flat no-caps label="Cerrar" class="pd-btn-secondary" />
              </div>
            </q-date>
          </q-popup-proxy>
        </q-icon>
      </template>
    </q-input>
    <q-btn
      type="submit"
      class="pd-btn-secondary"
      flat
      no-caps
      icon="filter_alt"
      label="Aplicar"
      data-test="range-apply"
    />
    <q-btn
      type="button"
      class="pd-btn-secondary"
      flat
      no-caps
      icon="filter_alt_off"
      label="Limpiar filtros"
      data-test="range-clear"
      @click="clear"
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
