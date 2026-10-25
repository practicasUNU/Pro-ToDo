<script setup lang="ts">
import { computed } from 'vue';

import { formatInteger, formatUsd } from '@/utils/number-format';

import type { ModelBreakdownRow } from '@/types/telemetry';

/**
 * Coste por modelo en barras horizontales.
 *
 * Sin libreria de graficos a proposito: barras de `q-linear-progress` bastan
 * para comparar pocos modelos y, a diferencia de un `<canvas>`, cada barra
 * lleva su cifra como TEXTO junto a ella. El dato no depende de interpretar
 * una longitud ni un color (WCAG 1.1.1 y 1.4.1), y la tabla de desglose queda
 * al lado para quien prefiera los numeros exactos.
 */
const props = defineProps<{
  breakdown: readonly ModelBreakdownRow[];
  loading?: boolean;
}>();

interface Bar {
  readonly key: string;
  readonly model: string;
  readonly provider: string;
  /** Proporcion respecto al modelo mas caro, entre 0 y 1. */
  readonly ratio: number;
  readonly cost: string;
  readonly tokens: string;
}

const bars = computed<Bar[]>(() => {
  const maxCost = Math.max(0, ...props.breakdown.map((row) => row.costUsd));

  return props.breakdown.map((row) => ({
    key: `${row.aiProvider}:${row.aiModel}`,
    model: row.aiModel,
    provider: row.aiProvider,
    ratio: maxCost === 0 ? 0 : row.costUsd / maxCost,
    cost: formatUsd(row.costUsd),
    tokens: formatInteger(row.totalTokens),
  }));
});
</script>

<template>
  <section class="pd-card pd-cost-chart" aria-labelledby="pd-cost-chart-title">
    <h2 id="pd-cost-chart-title" class="pd-h2 pd-cost-chart__title">Coste por modelo</h2>

    <div v-if="loading" class="pd-cost-chart__list">
      <q-skeleton v-for="index in 3" :key="index" type="rect" height="34px" />
    </div>

    <p v-else-if="bars.length === 0" class="pd-cost-chart__empty" data-test="chart-empty">
      No hay consumo de IA registrado en el periodo.
    </p>

    <ul v-else class="pd-cost-chart__list" role="list">
      <li v-for="bar in bars" :key="bar.key" class="pd-cost-chart__item" data-test="chart-bar">
        <div class="pd-cost-chart__legend">
          <span class="pd-mono">{{ bar.model }}</span>
          <span class="pd-cost-chart__provider">{{ bar.provider }}</span>
          <strong class="pd-cost-chart__cost">{{ bar.cost }}</strong>
        </div>
        <q-linear-progress
          :value="bar.ratio"
          size="10px"
          rounded
          track-color="transparent"
          class="pd-cost-chart__bar"
          :aria-label="`${bar.model}: ${bar.cost}, ${bar.tokens} tokens`"
        />
      </li>
    </ul>
  </section>
</template>

<style scoped lang="scss">
.pd-cost-chart {
  padding: 16px;
}

.pd-cost-chart__title {
  margin: 0 0 12px;
}

.pd-cost-chart__list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.pd-cost-chart__legend {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}

.pd-cost-chart__provider {
  color: var(--pd-text-secondary);
  font-size: 0.75rem;
}

.pd-cost-chart__cost {
  margin-left: auto;
  color: var(--pd-text-primary);
}

.pd-cost-chart__bar {
  background: var(--pd-surface-muted);
  color: var(--pd-primary);
}

.pd-cost-chart__empty {
  margin: 0;
  color: var(--pd-text-secondary);
}
</style>
