// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { QIcon, QSkeleton, Quasar } from 'quasar';
import { describe, expect, it } from 'vitest';

import TelemetrySummaryCards from '@components/dashboard/TelemetrySummaryCards.vue';

import type { TelemetrySummary } from '@/types/telemetry';

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

const mountCards = (summary: TelemetrySummary | null, loading = false) =>
  mount(TelemetrySummaryCards, {
    props: { summary, loading },
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
    expect(wrapper.text()).toContain('Sin ejecuciones concluidas');
  });

  it('1.3 deberia mostrar esqueletos mientras carga', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const wrapper = mountCards(null, true);

    // 3. Assert 🎯
    expect(wrapper.findAll('[data-test="kpi-value"]')).toHaveLength(0);
    expect(wrapper.findAllComponents(QSkeleton)).toHaveLength(4);
  });
});
