<script setup lang="ts">
import { computed, ref } from 'vue';

import {
  CRON_EXPRESSION_FIELD_COUNT,
  CRON_TIMEZONE_SUGGESTIONS,
  DEFAULT_CRON_OUTPUT_NAMESPACE,
  isIanaTimeZone,
  isLikelyCronExpression,
  useTriggerCronStore,
} from '@stores/nodes/trigger-cron.store';

interface Props {
  /** Identificador del nodo en el `pipeline_schema` (contrato uniforme §3.1). */
  nodeId: string;
}

const props = defineProps<Props>();

// El store se resuelve POR NODO: dos programaciones en el mismo flujo tienen
// cada una su propia configuracion, no una compartida.
const store = useTriggerCronStore(props.nodeId);

// Mensajes de regla como constantes: el mismo texto lo usan la regla del campo
// y la ayuda bajo el input, y duplicarlo los dejaria divergir.
const CRON_EXPRESSION_HINT = `${CRON_EXPRESSION_FIELD_COUNT} campos separados por espacios: minuto hora dia mes dia-semana. No se admiten segundos ni alias como @daily.`;

const TIME_ZONE_HINT =
  'Escribe cualquier nombre IANA o elige una de las sugerencias. La expresion se interpreta en esta zona y sigue el horario de verano, asi que un disparo a las 02:00 no ocurre el dia del salto de primavera: esa hora local no existe.';

const TIME_ZONE_INVALID_MESSAGE =
  'Nombre de zona IANA no reconocido (ej. Europe/Madrid, Asia/Tokyo o UTC). No se admiten desplazamientos fijos como +02:00 porque no siguen el horario de verano.';

/** Sugerencias visibles; se acotan al teclear (ver `onFilterTimeZones`). */
const timeZoneSuggestions = ref<string[]>([...CRON_TIMEZONE_SUGGESTIONS]);

/**
 * Acota las sugerencias a lo tecleado.
 *
 * Quasar EXIGE invocar `update()`: sin esa llamada el menu no se repinta y la
 * lista se queda congelada en las doce iniciales.
 */
const onFilterTimeZones = (
  inputValue: string,
  update: (callbackFn: () => void) => void,
): void => {
  update(() => {
    const needle = inputValue.toLowerCase();

    timeZoneSuggestions.value = CRON_TIMEZONE_SUGGESTIONS.filter((zone) =>
      zone.toLowerCase().includes(needle),
    );
  });
};

/**
 * Recoge lo TECLEADO aunque no se confirme con Enter ni se elija del menu.
 *
 * Es la pieza critica del campo: `update:model-value` solo se emite al
 * confirmar, asi que sin esto escribir "Asia/Tokyo" y pulsar Guardar
 * directamente persistiria la zona ANTERIOR mientras la pantalla muestra la
 * nueva. Seria un fallo silencioso peor que el que este cambio arregla.
 *
 * Se ignora la cadena vacia porque QSelect tambien la emite al abrir el menu
 * con `fill-input`, y eso borraria una zona ya valida.
 */
const onTimeZoneInput = (value: string): void => {
  const typed = value.trim();

  if (typed === '' || typed === store.config.timeZone) return;

  store.patchConfig({ timeZone: typed });
};

const OUTPUT_NAMESPACE_HINT = `El nodo escribe su marca temporal en el namespace \`${DEFAULT_CRON_OUTPUT_NAMESPACE}\`, interpolable como {{${DEFAULT_CRON_OUTPUT_NAMESPACE}.triggered_at}}.`;

/** Ejemplos frecuentes, para no obligar a recordar la sintaxis de memoria. */
const EXPRESSION_PRESETS: ReadonlyArray<{ label: string; value: string }> = [
  { label: 'Cada hora', value: '0 * * * *' },
  { label: 'Cada dia a las 9:00', value: '0 9 * * *' },
  { label: 'Laborables a las 9:00', value: '0 9 * * 1-5' },
  { label: 'Lunes a las 8:30', value: '30 8 * * 1' },
  { label: 'Dia 1 de cada mes', value: '0 6 1 * *' },
];

/**
 * Desglose de la expresion actual, para que el operador vea que campo escribe.
 *
 * Solo se muestra cuando la expresion es plausible: con una a medio escribir el
 * desglose confundiria mas que ayudar.
 */
const expressionBreakdown = computed<string[] | null>(() => {
  if (!isLikelyCronExpression(store.config.cronExpression)) {
    return null;
  }

  return store.config.cronExpression.trim().split(/\s+/);
});

const FIELD_LABELS = ['Minuto', 'Hora', 'Dia', 'Mes', 'Dia de semana'] as const;
</script>

<template>
  <section class="pd-card q-pa-md" :data-node-id="nodeId">
    <header class="row items-center no-wrap q-gutter-sm q-mb-md">
      <span class="pd-icon-circle">
        <q-icon name="schedule" size="20px" class="pd-node-icon" />
      </span>
      <div>
        <div class="pd-h2">Disparador Cron</div>
        <div class="pd-subtitle">
          Inicia el flujo de forma recurrente segun una programacion temporal.
        </div>
      </div>
      <q-space />
      <q-badge v-if="store.isConfigValid" class="pd-badge pd-schedule-badge--ok">
        Programacion valida
      </q-badge>
    </header>

    <div class="row q-col-gutter-md">
      <div class="col-12">
        <label class="pd-label" for="cron-expression">
          Expresion cron<span class="pd-required">*</span>
        </label>
        <q-input
          id="cron-expression"
          :model-value="store.config.cronExpression"
          outlined
          dense
          class="q-mt-xs pd-mono"
          placeholder="0 9 * * 1-5"
          :hint="CRON_EXPRESSION_HINT"
          :rules="[
            (val: string) => !!val?.trim() || 'La expresion es obligatoria',
            (val: string) => isLikelyCronExpression(val ?? '') || CRON_EXPRESSION_HINT,
          ]"
          @update:model-value="store.patchConfig({ cronExpression: String($event ?? '') })"
        />

        <div v-if="expressionBreakdown" class="row q-gutter-xs q-mt-sm">
          <div
            v-for="(field, index) in expressionBreakdown"
            :key="FIELD_LABELS[index]"
            class="pd-cron-field"
          >
            <span class="pd-cron-field__label">{{ FIELD_LABELS[index] }}</span>
            <span class="pd-mono pd-cron-field__value">{{ field }}</span>
          </div>
        </div>
      </div>

      <div class="col-12">
        <div class="pd-subtitle q-mb-xs">Programaciones frecuentes</div>
        <div class="row q-gutter-xs">
          <q-chip
            v-for="preset in EXPRESSION_PRESETS"
            :key="preset.value"
            clickable
            class="pd-preset-chip"
            :label="preset.label"
            @click="store.patchConfig({ cronExpression: preset.value })"
          />
        </div>
      </div>

      <div class="col-12 col-md-6">
        <label class="pd-label" for="cron-timezone">
          Zona horaria<span class="pd-required">*</span>
        </label>
        <!-- Selector ABIERTO a proposito. La lista cerrada anterior declaraba
             invalida cualquier zona que el backend si acepta, y como no se podia
             escribir, un nodo guardado con `Asia/Tokyo` quedaba imposible de
             reabrir: bloqueaba el guardado del flujo entero sin via de escape.
             Las doce sugerencias se mantienen; la validez la decide
             `isIanaTimeZone`, espejo del DTO del backend. -->
        <q-select
          id="cron-timezone"
          :model-value="store.config.timeZone"
          :options="timeZoneSuggestions"
          outlined
          dense
          use-input
          fill-input
          hide-selected
          input-debounce="0"
          new-value-mode="add-unique"
          lazy-rules
          class="q-mt-xs"
          :hint="TIME_ZONE_HINT"
          :rules="[
            (val: string) => !!val?.trim() || 'La zona horaria es obligatoria',
            (val: string) => isIanaTimeZone((val ?? '').trim()) || TIME_ZONE_INVALID_MESSAGE,
          ]"
          @filter="onFilterTimeZones"
          @update:model-value="store.patchConfig({ timeZone: String($event ?? '').trim() })"
          @input-value="onTimeZoneInput"
        />
      </div>

      <div class="col-12 col-md-6">
        <label class="pd-label">Salida del nodo</label>
        <div class="pd-namespace-note q-mt-xs">
          <span class="pd-mono">{{ DEFAULT_CRON_OUTPUT_NAMESPACE }}</span>
          <span class="pd-subtitle q-ml-sm">{{ OUTPUT_NAMESPACE_HINT }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.pd-node-icon {
  color: var(--pd-primary);
}

.pd-schedule-badge--ok {
  background: var(--pd-positive);
  color: #ffffff;
}

.pd-cron-field {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 72px;
  padding: 4px 8px;
  border: 1px solid var(--pd-border);
  border-radius: 6px;
  background: var(--pd-surface-muted);
}

.pd-cron-field__label {
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--pd-text-secondary);
}

.pd-cron-field__value {
  color: var(--pd-text-primary);
}

.pd-preset-chip {
  background: var(--pd-surface-muted);
  color: var(--pd-accent-text);
}

.pd-namespace-note {
  padding: 8px 12px;
  border: 1px solid var(--pd-border);
  border-radius: 6px;
  background: var(--pd-surface-muted);
}

// Campos e inputs sobre los tokens del sistema (regla §2, Formularios). Mismo
// bloque que en TriggerImapConfig; candidato a subir a app.scss cuando se pueda
// tocar componentes ajenos a esta rama.
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
