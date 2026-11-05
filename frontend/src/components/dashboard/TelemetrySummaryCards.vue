<script setup lang="ts">
import { computed } from 'vue';

import { EMPTY_VALUE, formatInteger, formatPercent, formatUsd } from '@/utils/number-format';

import type { ModelBreakdownRow, TelemetrySummary } from '@/types/telemetry';

/**
 * KPI del consumo de IA: tokens, coste, invocaciones y dos tasas de exito
 * DISTINTAS a proposito:
 *
 * - Flujos con IA: ejecuciones concluidas con exito sobre las que invocaron al
 *   menos un modelo. Un flujo sin IA no entra en la cuenta.
 * - Llamadas por modelo: llamadas SUCCESS sobre todas las registradas, con el
 *   modelo menos fiable en la pista. Solo aparece si se pasa el desglose.
 *
 * Presentacional: recibe el resumen ya cargado. Cada tarjeta es un `<article>`
 * con su titulo como encabezado, de modo que un lector de pantalla anuncia
 * "Coste total, 2,30 US$" y no una cifra suelta.
 */
const props = defineProps<{
  summary: TelemetrySummary | null;
  /** Desglose por modelo; sin el no se pinta la tarjeta de exito por modelo. */
  breakdown?: readonly ModelBreakdownRow[] | undefined;
  loading?: boolean;
}>();

interface KpiCard {
  readonly key: string;
  readonly icon: string;
  readonly label: string;
  readonly value: string;
  readonly hint: string;
  /** Pista en varias lineas; si existe, sustituye a `hint`. */
  readonly hintLines?: readonly string[];
}

const FLOW_SUCCESS_LABEL = 'Tasa de éxito de flujos con IA';
const MODEL_SUCCESS_LABEL = 'Tasa de éxito por modelo';

/** Modelo con la tasa mas alta (`pick > 0`) o mas baja (`pick < 0`). */
const extremeModel = (rows: readonly ModelBreakdownRow[], pick: 1 | -1): ModelBreakdownRow | null =>
  rows
    .filter((row) => row.successRate !== null)
    .reduce<ModelBreakdownRow | null>(
      (best, row) =>
        best === null || ((row.successRate ?? 0) - (best.successRate ?? 0)) * pick > 0 ? row : best,
      null,
    );

const describeModel = (row: ModelBreakdownRow): string =>
  `${row.aiModel} (${formatPercent(row.successRate)})`;

/**
 * Exito de las llamadas sumando todos los modelos, con el mejor y el peor
 * modelo debajo: el segundo es el que conviene revisar, y el primero dice si
 * hay una alternativa mejor a mano.
 */
const modelSuccessCard = computed<KpiCard | null>(() => {
  if (props.breakdown === undefined) return null;

  const rows = props.breakdown;
  const invocations = rows.reduce((total, row) => total + row.invocations, 0);
  const succeeded = rows.reduce((total, row) => total + row.succeeded, 0);
  const highest = extremeModel(rows, 1);
  const lowest = extremeModel(rows, -1);

  return {
    key: 'model-success',
    icon: 'insights',
    label: MODEL_SUCCESS_LABEL,
    value: invocations === 0 ? EMPTY_VALUE : formatPercent(succeeded / invocations),
    hint: 'Sin llamadas a modelos en el periodo',
    ...(highest !== null && lowest !== null
      ? { hintLines: [`Mayor: ${describeModel(highest)}`, `Menor: ${describeModel(lowest)}`] }
      : {}),
  };
});

const cards = computed<KpiCard[]>(() => {
  const summary = props.summary;
  const extra = modelSuccessCard.value === null ? [] : [modelSuccessCard.value];

  if (summary === null) {
    return [
      { key: 'tokens', icon: 'data_usage', label: 'Tokens totales', value: EMPTY_VALUE, hint: '' },
      { key: 'cost', icon: 'payments', label: 'Coste total', value: EMPTY_VALUE, hint: '' },
      { key: 'calls', icon: 'smart_toy', label: 'Invocaciones IA', value: EMPTY_VALUE, hint: '' },
      { key: 'success', icon: 'task_alt', label: FLOW_SUCCESS_LABEL, value: EMPTY_VALUE, hint: '' },
      // Sin resumen tampoco hay Mayor/Menor que mostrar: solo la etiqueta.
      ...extra.map(({ key, icon, label }) => ({ key, icon, label, value: EMPTY_VALUE, hint: '' })),
    ];
  }

  return [
    {
      key: 'tokens',
      icon: 'data_usage',
      label: 'Tokens totales',
      value: formatInteger(summary.totalTokens),
      hint: 'Prompt, completación y razonamiento',
    },
    {
      key: 'cost',
      icon: 'payments',
      label: 'Coste total',
      value: formatUsd(summary.totalCostUsd),
      hint:
        summary.estimatedInvocations > 0
          ? `${formatInteger(summary.estimatedInvocations)} con coste aproximado`
          : 'Calculado con tarifas exactas',
    },
    {
      key: 'calls',
      icon: 'smart_toy',
      label: 'Invocaciones IA',
      value: formatInteger(summary.aiInvocations),
      hint: 'Llamadas registradas, exitosas y fallidas',
    },
    {
      key: 'success',
      icon: 'task_alt',
      label: FLOW_SUCCESS_LABEL,
      value: formatPercent(summary.successRate),
      hint:
        summary.executionsTotal === 0
          ? 'Sin ejecuciones con IA concluidas en el periodo'
          : `${formatInteger(summary.executionsSucceeded)} de ${formatInteger(summary.executionsTotal)} ejecuciones con IA`,
    },
    ...extra,
  ];
});
</script>

<template>
  <section class="pd-kpi-grid" aria-label="Indicadores de consumo de IA">
    <article
      v-for="card in cards"
      :key="card.key"
      class="pd-card pd-kpi"
      :aria-busy="loading ? 'true' : 'false'"
      :data-test="`kpi-${card.key}`"
    >
      <div class="pd-kpi__icon" aria-hidden="true">
        <q-icon :name="card.icon" size="22px" />
      </div>
      <div class="pd-kpi__body">
        <h3 class="pd-kpi__label">{{ card.label }}</h3>
        <q-skeleton v-if="loading" type="text" width="80%" class="pd-kpi__skeleton" />
        <p v-else class="pd-kpi__value" data-test="kpi-value">{{ card.value }}</p>
        <template v-if="!loading && card.hintLines">
          <p
            v-for="line in card.hintLines"
            :key="line"
            class="pd-kpi__hint"
            data-test="kpi-hint-line"
          >
            {{ line }}
          </p>
        </template>
        <p v-else-if="!loading && card.hint" class="pd-kpi__hint">{{ card.hint }}</p>
      </div>
    </article>
  </section>
</template>

<style scoped lang="scss">
.pd-kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 16px;
}

.pd-kpi {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  padding: 16px;
}

// Contenedor de icono en circulo punteado, glifo en color de marca (§2).
.pd-kpi__icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 1px dashed var(--pd-border);
  background: var(--pd-surface-muted);
  color: var(--pd-primary);
}

.pd-kpi__body {
  min-width: 0;
}

.pd-kpi__label {
  margin: 0;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.025rem;
  text-transform: uppercase;
  color: var(--pd-text-secondary);
}

.pd-kpi__value {
  margin: 4px 0 0;
  font-size: 1.5rem;
  font-weight: 700;
  line-height: 1.2;
  color: var(--pd-text-primary);
  overflow-wrap: anywhere;
}

.pd-kpi__skeleton {
  margin-top: 8px;
}

.pd-kpi__hint {
  margin: 4px 0 0;
  font-size: 0.75rem;
  color: var(--pd-text-secondary);
}
</style>
