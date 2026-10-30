<script setup lang="ts">
import { computed } from 'vue';

import { EMPTY_VALUE, formatInteger, formatPercent } from '@/utils/number-format';

import type { ModelBreakdownRow } from '@/types/telemetry';

/**
 * Tasa de exito de las llamadas por modelo, en barras horizontales.
 *
 * Gemela de `TelemetryCostChart` y por el mismo motivo sin libreria de
 * graficos: cada barra lleva su porcentaje y sus fallidas como TEXTO, de modo
 * que el dato no depende de leer una longitud ni un color (WCAG 1.1.1 y 1.4.1).
 * Un modelo sin llamadas en el periodo muestra "—" y una barra vacia.
 */
const props = defineProps<{
  breakdown: readonly ModelBreakdownRow[];
  loading?: boolean;
}>();

interface Bar {
  readonly key: string;
  readonly model: string;
  readonly provider: string;
  /** Tasa de exito entre 0 y 1; 0 si no hay llamadas. */
  readonly ratio: number;
  readonly rate: string;
  readonly failed: string;
}

const bars = computed<Bar[]>(() =>
  props.breakdown.map((row) => ({
    key: `${row.aiProvider}:${row.aiModel}`,
    model: row.aiModel,
    provider: row.aiProvider,
    ratio: row.successRate ?? 0,
    rate: row.successRate === null ? EMPTY_VALUE : formatPercent(row.successRate),
    failed: `${formatInteger(row.failed)} fallidas`,
  })),
);
</script>

<template>
  <section class="pd-card pd-success-chart" aria-labelledby="pd-success-chart-title">
    <h2 id="pd-success-chart-title" class="pd-h2 pd-success-chart__title">
      Tasa de éxito por modelo
    </h2>

    <div v-if="loading" class="pd-success-chart__list">
      <q-skeleton v-for="index in 3" :key="index" type="rect" height="34px" />
    </div>

    <p
      v-else-if="bars.length === 0"
      class="pd-success-chart__empty"
      data-test="success-chart-empty"
    >
      No hay llamadas a modelos registradas en el periodo.
    </p>

    <ul v-else class="pd-success-chart__list" role="list">
      <li
        v-for="bar in bars"
        :key="bar.key"
        class="pd-success-chart__item"
        data-test="success-chart-bar"
      >
        <div class="pd-success-chart__legend">
          <span class="pd-mono">{{ bar.model }}</span>
          <span class="pd-success-chart__meta">{{ bar.provider }} · {{ bar.failed }}</span>
          <strong class="pd-success-chart__rate" data-test="success-chart-rate">{{
            bar.rate
          }}</strong>
        </div>
        <q-linear-progress
          :value="bar.ratio"
          size="10px"
          rounded
          track-color="transparent"
          class="pd-success-chart__bar"
          :aria-label="`${bar.model}: ${bar.rate} de éxito, ${bar.failed}`"
        />
      </li>
    </ul>
  </section>
</template>

<style scoped lang="scss">
.pd-success-chart {
  padding: 16px;
}

.pd-success-chart__title {
  margin: 0 0 12px;
}

.pd-success-chart__list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.pd-success-chart__legend {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}

.pd-success-chart__meta {
  color: var(--pd-text-secondary);
  font-size: 0.75rem;
}

.pd-success-chart__rate {
  margin-left: auto;
  color: var(--pd-text-primary);
}

.pd-success-chart__bar {
  background: var(--pd-surface-muted);
  color: var(--pd-positive);
}

.pd-success-chart__empty {
  margin: 0;
  color: var(--pd-text-secondary);
}
</style>
