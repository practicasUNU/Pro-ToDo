// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { QLinearProgress, QSkeleton, Quasar } from 'quasar';
import { describe, expect, it } from 'vitest';

import TelemetryModelSuccessChart from '@components/dashboard/TelemetryModelSuccessChart.vue';

import type { ModelBreakdownRow } from '@/types/telemetry';

const buildRow = (overrides: Partial<ModelBreakdownRow> = {}): ModelBreakdownRow => ({
  aiProvider: 'GEMINI',
  aiModel: 'gemini-3.6-flash',
  invocations: 4,
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  succeeded: 3,
  failed: 1,
  successRate: 0.75,
  ...overrides,
});

const mountChart = (breakdown: ModelBreakdownRow[], loading = false) =>
  mount(TelemetryModelSuccessChart, {
    props: { breakdown, loading },
    global: {
      plugins: [Quasar],
      components: { QLinearProgress, QSkeleton },
    },
  });

describe('TelemetryModelSuccessChart', () => {
  it('1.1 deberia pintar la tasa y las fallidas como texto en cada barra', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const wrapper = mountChart([buildRow()]);

    // 3. Assert 🎯: el dato no depende de leer la longitud de la barra.
    const bar = wrapper.get('[data-test="success-chart-bar"]');
    expect(bar.text()).toContain('gemini-3.6-flash');
    expect(bar.text()).toContain('1 fallidas');
    expect(wrapper.get('[data-test="success-chart-rate"]').text()).toMatch(/75\s%/);
    expect(wrapper.getComponent(QLinearProgress).props('value')).toBe(0.75);
  });

  it('1.2 deberia mostrar un guion para un modelo sin tasa calculable', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const wrapper = mountChart([buildRow({ invocations: 0, successRate: null })]);

    // 3. Assert 🎯
    expect(wrapper.get('[data-test="success-chart-rate"]').text()).toBe('—');
    expect(wrapper.getComponent(QLinearProgress).props('value')).toBe(0);
  });

  it('1.3 deberia avisar cuando no hay llamadas en el periodo', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const wrapper = mountChart([]);

    // 3. Assert 🎯
    expect(wrapper.find('[data-test="success-chart-empty"]').exists()).toBe(true);
  });

  it('1.4 deberia mostrar esqueletos mientras carga', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const wrapper = mountChart([buildRow()], true);

    // 3. Assert 🎯
    expect(wrapper.findAllComponents(QSkeleton)).toHaveLength(3);
  });
});
