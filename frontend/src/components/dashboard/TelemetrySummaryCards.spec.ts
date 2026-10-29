// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { QIcon, QSkeleton, Quasar } from 'quasar';
import { describe, expect, it } from 'vitest';

import TelemetrySummaryCards from '@components/dashboard/TelemetrySummaryCards.vue';

import type { ModelBreakdownRow, TelemetrySummary } from '@/types/telemetry';

const SUMMARY: TelemetrySummary = {
  range: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-23T00:00:00.000Z' },
  totalTokens: 1_234_567,
  totalCostUsd: 2.3,
  aiInvocations: 4,
  estimatedInvocations: 1,
  executionsTotal: 4,
  executionsSucceeded: 3,
  successRate: 0.75,
};

const buildRow = (overrides: Partial<ModelBreakdownRow>): ModelBreakdownRow => ({
  aiProvider: 'ANTHROPIC',
  aiModel: 'claude-sonnet-5-5',
  invocations: 4,
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  succeeded: 4,
  failed: 0,
  successRate: 1,
  ...overrides,
});

const mountCards = (
  summary: TelemetrySummary | null,
  loading = false,
  breakdown?: ModelBreakdownRow[],
) =>
  mount(TelemetrySummaryCards, {
    props: { summary, loading, ...(breakdown !== undefined ? { breakdown } : {}) },
    global: { plugins: [Quasar], components: { QIcon, QSkeleton } },
  });

const valueOf = (wrapper: ReturnType<typeof mountCards>, key: string): string =>
  wrapper.get(`[data-test="kpi-${key}"] [data-test="kpi-value"]`).text();

describe('TelemetrySummaryCards', () => {
  it('1.1 deberia pintar los cuatro KPI con formato es-ES', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const wrapper = mountCards(SUMMARY);

    // 3. Assert 🎯
    expect(valueOf(wrapper, 'tokens')).toBe('1.234.567');
    expect(valueOf(wrapper, 'cost')).toContain('2,30');
    expect(valueOf(wrapper, 'calls')).toBe('4');
    expect(valueOf(wrapper, 'success')).toMatch(/75\s%/);
    expect(wrapper.text()).toContain('1 con coste aproximado');
  });

  it('1.2 deberia decir "sin datos" y no 0 % cuando no hubo ejecuciones', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const wrapper = mountCards({ ...SUMMARY, executionsTotal: 0, successRate: null });

    // 3. Assert 🎯
    expect(valueOf(wrapper, 'success')).toBe('—');
    expect(wrapper.text()).toContain('Sin ejecuciones con IA concluidas');
  });

  it('1.3 deberia mostrar esqueletos mientras carga', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const wrapper = mountCards(null, true);

    // 3. Assert 🎯
    expect(wrapper.findAll('[data-test="kpi-value"]')).toHaveLength(0);
    expect(wrapper.findAllComponents(QSkeleton)).toHaveLength(4);
  });

  it('1.4 deberia distinguir la tasa de flujos con IA de la tasa por modelo', () => {
    // 1. Arrange 📐: 3 de 4 flujos con IA; 6 de 8 llamadas, Flash la peor.
    const breakdown = [
      buildRow({}),
      buildRow({
        aiProvider: 'GEMINI',
        aiModel: 'gemini-3.6-flash',
        succeeded: 2,
        failed: 2,
        successRate: 0.5,
      }),
    ];

    // 2. Act ⚙️
    const wrapper = mountCards(SUMMARY, false, breakdown);

    // 3. Assert 🎯
    expect(wrapper.get('[data-test="kpi-success"]').text()).toContain(
      'Tasa de éxito de flujos con IA',
    );
    expect(wrapper.get('[data-test="kpi-success"]').text()).toContain('3 de 4 ejecuciones con IA');
    expect(valueOf(wrapper, 'model-success')).toMatch(/75\s%/);
    expect(wrapper.get('[data-test="kpi-model-success"]').text()).toContain(
      'Menor: gemini-3.6-flash',
    );
  });

  it('1.5 no deberia pintar la tarjeta por modelo sin desglose', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const wrapper = mountCards(SUMMARY);

    // 3. Assert 🎯
    expect(wrapper.find('[data-test="kpi-model-success"]').exists()).toBe(false);
  });
});
