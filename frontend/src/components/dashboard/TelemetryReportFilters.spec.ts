// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { QBtn, QForm, QIcon, QInput, QSelect, Quasar } from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@services/telemetry.service', () => ({
  fetchSummary: vi.fn(),
  fetchBreakdownByModel: vi.fn(),
  fetchHistory: vi.fn(),
  fetchFilterOptions: vi.fn(),
}));

vi.mock('@services/reports.service', () => ({
  downloadCsv: vi.fn(),
  downloadPdf: vi.fn(),
}));

import TelemetryReportFilters from '@components/dashboard/TelemetryReportFilters.vue';
import { useTelemetryStore } from '@stores/telemetry.store';

const OPTIONS = {
  providers: ['ANTHROPIC', 'GEMINI'],
  models: [
    { aiProvider: 'ANTHROPIC', aiModel: 'claude-sonnet-5-5' },
    { aiProvider: 'GEMINI', aiModel: 'gemini-3.6-flash' },
  ],
  flows: [
    { id: 'f1', name: 'Notiweb' },
    { id: 'f2', name: 'Boletin' },
  ],
  nodes: [
    { flowId: 'f1', nodeId: 'nodo_ia' },
    { flowId: 'f2', nodeId: 'ocr' },
  ],
};

const mountFilters = () =>
  mount(TelemetryReportFilters, {
    global: { plugins: [Quasar], components: { QBtn, QForm, QIcon, QInput, QSelect } },
  });

/** El `data-test` de QSelect no queda en su raiz: se localiza por su etiqueta. */
const selectByLabel = (wrapper: ReturnType<typeof mountFilters>, label: string) =>
  wrapper.findAllComponents(QSelect).find((select) => select.props('label') === label);

describe('TelemetryReportFilters', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('1.1 deberia ofrecer solo los modelos del proveedor elegido', async () => {
    // 1. Arrange 📐
    const store = useTelemetryStore();
    store.filterOptions = OPTIONS;
    store.setFilters({ aiProvider: 'GEMINI' });

    // 2. Act ⚙️
    const wrapper = mountFilters();
    await flushPromises();

    // 3. Assert 🎯: selector cerrado, sin texto libre (Poka-Yoke).
    expect(selectByLabel(wrapper, 'Modelo')?.props('options')).toEqual([
      { label: 'gemini-3.6-flash', value: 'gemini-3.6-flash' },
    ]);
  });

  it('1.2 deberia aplicar el proveedor, vaciar el modelo y emitir apply', async () => {
    // 1. Arrange 📐
    const store = useTelemetryStore();
    store.filterOptions = OPTIONS;
    store.setFilters({ aiProvider: 'GEMINI', aiModel: 'gemini-3.6-flash' });
    const wrapper = mountFilters();

    // 2. Act ⚙️
    selectByLabel(wrapper, 'Proveedor')?.vm.$emit('update:modelValue', 'ANTHROPIC');
    await flushPromises();

    // 3. Assert 🎯
    expect(store.filters.aiProvider).toBe('ANTHROPIC');
    expect(store.filters.aiModel).toBeUndefined();
    expect(wrapper.emitted('apply')).toHaveLength(1);
  });

  it('1.3 deberia ofrecer los nodos del flujo elegido', async () => {
    // 1. Arrange 📐
    const store = useTelemetryStore();
    store.filterOptions = OPTIONS;
    store.setFilters({ flowId: 'f2' });

    // 2. Act ⚙️
    const wrapper = mountFilters();
    await flushPromises();

    // 3. Assert 🎯
    expect(selectByLabel(wrapper, 'Nodo')?.props('options')).toEqual([
      { label: 'ocr', value: 'ocr' },
    ]);
  });

  it('1.4 deberia ordenar el desglose de menor a mayor por tokens de prompt', async () => {
    // 1. Arrange 📐
    const store = useTelemetryStore();
    const wrapper = mountFilters();

    // 2. Act ⚙️
    selectByLabel(wrapper, 'Ordenar desglose por')?.vm.$emit('update:modelValue', 'promptTokens');
    selectByLabel(wrapper, 'Sentido')?.vm.$emit('update:modelValue', 'ASC');
    await flushPromises();

    // 3. Assert 🎯
    expect(store.breakdownSort).toEqual({ sortBy: 'promptTokens', descending: false });
    expect(store.query).toMatchObject({
      breakdownSortBy: 'promptTokens',
      breakdownSortOrder: 'ASC',
    });
    expect(wrapper.emitted('apply')).toHaveLength(2);
  });
});
