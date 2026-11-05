// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { QBtn, Quasar } from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// El aviso se observa doblando `useQuasar`: espiar el plugin llega tarde
// porque el componente captura `$q` al montarse.
const { notify } = vi.hoisted(() => ({ notify: vi.fn() }));

vi.mock('quasar', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('quasar')),
  useQuasar: () => ({ notify }),
}));

// El panel se recarga por socket; aqui no hay servidor al que conectarse.
vi.mock('@/composables/usePanelRefresh', () => ({
  usePanelRefresh: vi.fn(),
}));

vi.mock('@services/telemetry.service', () => ({
  fetchSummary: vi.fn(),
  fetchBreakdownByModel: vi.fn(),
  fetchHistory: vi.fn(),
}));

vi.mock('@services/reports.service', () => ({
  downloadCsv: vi.fn(),
  downloadPdf: vi.fn(),
}));

// El historial va doblado (stub), pero su modulo se importa igualmente: sin
// esto arrastraria `@boot/axios`.
vi.mock('@services/fsm-executions.service', () => ({
  fetchExecutions: vi.fn(),
  downloadExecutionsCsv: vi.fn(),
  downloadExecutionsPdf: vi.fn(),
}));

vi.mock('@services/workflows.service', () => ({
  fetchWorkflows: vi.fn().mockResolvedValue([]),
}));

vi.mock('@services/logs.service', () => ({
  fetchExecutionLog: vi.fn(),
}));

import DashboardOverview from '@components/dashboard/DashboardOverview.vue';

import { fetchBreakdownByModel, fetchSummary } from '@services/telemetry.service';

import type { TelemetrySummary } from '@/types/telemetry';

const SUMMARY: TelemetrySummary = {
  range: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z' },
  totalTokens: 0,
  totalCostUsd: 0,
  aiInvocations: 0,
  estimatedInvocations: 0,
  executionsTotal: 0,
  executionsSucceeded: 0,
  successRate: null,
};

const mountOverview = () =>
  mount(DashboardOverview, {
    global: {
      plugins: [Quasar],
      components: { QBtn },
      // Solo interesa la cabecera: el resto del panel tiene sus propios specs.
      stubs: {
        ExecutionsHistoryTable: true,
        TelemetryCostChart: true,
        TelemetryModelSuccessChart: true,
        TelemetrySummaryCards: true,
      },
    },
  });

describe('DashboardOverview', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(fetchSummary).mockResolvedValue(SUMMARY);
    vi.mocked(fetchBreakdownByModel).mockResolvedValue([]);
  });

  it('1.1 la cabecera solo deberia titular, sin enlace a Informes ni exportaciones', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const wrapper = mountOverview();
    await flushPromises();

    // 3. Assert 🎯: las exportaciones de telemetria viven en Informes, y el
    //    historial exporta las suyas desde su propia tabla.
    const header = wrapper.get('[data-test="dashboard-header"]');
    expect(header.text()).toContain('Panel de control');
    expect(wrapper.find('[data-test="go-reports"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="export-csv"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="export-pdf"]').exists()).toBe(false);
    expect(wrapper.findComponent({ name: 'ExportReportBar' }).exists()).toBe(false);
    expect(header.findAllComponents(QBtn)).toHaveLength(0);
  });

  it('1.2 deberia seguir cargando los KPIs de los ultimos 30 dias al montarse', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    mountOverview();
    await flushPromises();

    // 3. Assert 🎯
    expect(fetchSummary).toHaveBeenCalledTimes(1);
    expect(fetchBreakdownByModel).toHaveBeenCalledTimes(1);
  });
});
