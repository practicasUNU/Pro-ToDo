import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useTelemetryStore } from './telemetry.store';

import type { ModelBreakdownRow, TelemetrySummary } from '@/types/telemetry';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
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

const telemetryService = await import('@services/telemetry.service');
const reportsService = await import('@services/reports.service');
const fetchSummary = vi.mocked(telemetryService.fetchSummary);
const fetchBreakdownByModel = vi.mocked(telemetryService.fetchBreakdownByModel);
const fetchHistory = vi.mocked(telemetryService.fetchHistory);
const fetchFilterOptions = vi.mocked(telemetryService.fetchFilterOptions);
const downloadCsv = vi.mocked(reportsService.downloadCsv);
const downloadPdf = vi.mocked(reportsService.downloadPdf);

const buildSummary = (overrides: Partial<TelemetrySummary> = {}): TelemetrySummary => ({
  range: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-23T00:00:00.000Z' },
  totalTokens: 1_600,
  totalCostUsd: 2.3,
  aiInvocations: 4,
  estimatedInvocations: 1,
  executionsTotal: 4,
  executionsSucceeded: 3,
  successRate: 0.75,
  ...overrides,
});

const BREAKDOWN: ModelBreakdownRow[] = [
  {
    aiProvider: 'GEMINI',
    aiModel: 'gemini-3.6-flash',
    invocations: 4,
    promptTokens: 1_000,
    completionTokens: 500,
    reasoningTokens: 100,
    totalTokens: 1_600,
    costUsd: 2.3,
    succeeded: 3,
    failed: 1,
    successRate: 0.75,
  },
];

describe('useTelemetryStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('1.1 deberia cargar resumen y desglose con el rango convertido a instantes ISO', async () => {
    // 1. Arrange 📐
    fetchSummary.mockResolvedValue(buildSummary());
    fetchBreakdownByModel.mockResolvedValue(BREAKDOWN);
    const store = useTelemetryStore();
    store.setDateRange({ from: '2026-10-01', to: '2026-10-22' });

    // 2. Act ⚙️
    await store.loadDashboard();

    // 3. Assert 🎯: el fin avanza un dia (exclusivo) en el huso local.
    const expected = {
      from: new Date(2026, 9, 1).toISOString(),
      to: new Date(2026, 9, 23).toISOString(),
    };
    expect(fetchSummary).toHaveBeenCalledWith(expected);
    expect(fetchBreakdownByModel).toHaveBeenCalledWith(expected);
    expect(store.summary?.totalCostUsd).toBe(2.3);
    expect(store.breakdown).toEqual(BREAKDOWN);
    expect(store.isLoading).toBe(false);
  });

  it('1.2 deberia apagar isLoading y propagar el error si la API falla', async () => {
    // 1. Arrange 📐: el componente decide el aviso; el store solo libera.
    fetchSummary.mockRejectedValue(new Error('500'));
    fetchBreakdownByModel.mockResolvedValue([]);
    const store = useTelemetryStore();

    // 2. Act ⚙️ + 3. Assert 🎯
    await expect(store.loadDashboard()).rejects.toThrow('500');
    expect(store.isLoading).toBe(false);
  });

  it('1.3 deberia marcar el rango invertido como invalido y no enviarlo', () => {
    // 1. Arrange 📐
    const store = useTelemetryStore();

    // 2. Act ⚙️
    store.setDateRange({ from: '2026-10-22', to: '2026-10-01' });

    // 3. Assert 🎯: sin rango valido viaja vacio y el backend aplica su defecto.
    expect(store.isRangeValid).toBe(false);
    expect(store.query).toEqual({});
  });

  it('1.4 deberia calcular el coste medio por invocacion', async () => {
    // 1. Arrange 📐
    fetchSummary.mockResolvedValue(buildSummary({ totalCostUsd: 2, aiInvocations: 4 }));
    fetchBreakdownByModel.mockResolvedValue([]);
    const store = useTelemetryStore();

    // 2. Act ⚙️
    await store.loadDashboard();

    // 3. Assert 🎯
    expect(store.averageCostUsd).toBe(0.5);
  });

  it('2.1 deberia cargar una pagina del historial y recordar la paginacion', async () => {
    // 1. Arrange 📐
    fetchHistory.mockResolvedValue({ items: [], total: 120, limit: 50, offset: 50 });
    const store = useTelemetryStore();

    // 2. Act ⚙️
    await store.loadHistory({ limit: 50, offset: 50 });

    // 3. Assert 🎯
    expect(fetchHistory).toHaveBeenCalledWith(expect.objectContaining({ limit: 50, offset: 50 }));
    expect(store.historyTotal).toBe(120);
    expect(store.historyOffset).toBe(50);
    expect(store.isLoadingHistory).toBe(false);
  });

  it('3.1 deberia devolver el blob del formato pedido y apagar SOLO su indicador', async () => {
    // 1. Arrange 📐: el PDF tarda; el CSV no debe quedar bloqueado mientras.
    const pdf = new Blob(['%PDF'], { type: 'application/pdf' });
    let resolvePdf: (blob: Blob) => void = () => undefined;
    downloadPdf.mockReturnValue(new Promise<Blob>((resolve) => (resolvePdf = resolve)));
    const store = useTelemetryStore();

    // 2. Act ⚙️
    const pending = store.exportReport('pdf');

    // 3. Assert 🎯
    expect(store.exporting).toEqual({ csv: false, pdf: true });
    resolvePdf(pdf);
    await expect(pending).resolves.toBe(pdf);
    expect(store.exporting.pdf).toBe(false);
    expect(downloadCsv).not.toHaveBeenCalled();
  });

  it('3.2 deberia apagar el indicador de exportacion aunque la descarga falle', async () => {
    // 1. Arrange 📐
    downloadCsv.mockRejectedValue(new Error('403'));
    const store = useTelemetryStore();

    // 2. Act ⚙️ + 3. Assert 🎯
    await expect(store.exportReport('csv')).rejects.toThrow('403');
    expect(store.exporting.csv).toBe(false);
  });

  it('2.2 deberia mandar el orden del historial al servidor', async () => {
    // 1. Arrange 📐
    fetchHistory.mockResolvedValue({ items: [], total: 0, limit: 25, offset: 0 });
    const store = useTelemetryStore();
    store.setHistorySort({ sortBy: 'estimatedCostUsd', descending: true });

    // 2. Act ⚙️
    await store.loadHistory();

    // 3. Assert 🎯
    expect(fetchHistory).toHaveBeenCalledWith(
      expect.objectContaining({ sortBy: 'estimatedCostUsd', sortOrder: 'DESC' }),
    );
  });

  describe('4. Filtros y orden del informe', () => {
    it('4.1 deberia enviar proveedor, modelo, flujo, nodo y orden del desglose', async () => {
      // 1. Arrange 📐
      fetchSummary.mockResolvedValue(buildSummary());
      fetchBreakdownByModel.mockResolvedValue(BREAKDOWN);
      const store = useTelemetryStore();
      store.setFilters({ aiProvider: 'GEMINI', aiModel: 'gemini-3.6-flash', nodeId: 'nodo_ia' });
      store.setBreakdownSort({ sortBy: 'invocations', descending: false });

      // 2. Act ⚙️
      await store.loadDashboard();

      // 3. Assert 🎯
      expect(fetchBreakdownByModel).toHaveBeenCalledWith(
        expect.objectContaining({
          aiProvider: 'GEMINI',
          aiModel: 'gemini-3.6-flash',
          nodeId: 'nodo_ia',
          breakdownSortBy: 'invocations',
          breakdownSortOrder: 'ASC',
        }),
      );
      expect(fetchBreakdownByModel.mock.calls[0]?.[0]).not.toHaveProperty('flowId');
    });

    it('4.2 deberia exportar con los filtros, el orden del desglose y el del historial', async () => {
      // 1. Arrange 📐: el fichero tiene que decir lo mismo que la pantalla.
      downloadCsv.mockResolvedValue(new Blob(['csv']));
      const store = useTelemetryStore();
      store.setFilters({ flowId: 'f1' });
      store.setBreakdownSort({ sortBy: 'costUsd', descending: true });
      store.setHistorySort({ sortBy: 'totalTokens', descending: false });

      // 2. Act ⚙️
      await store.exportReport('csv');

      // 3. Assert 🎯
      expect(downloadCsv).toHaveBeenCalledWith(
        expect.objectContaining({
          flowId: 'f1',
          breakdownSortBy: 'costUsd',
          breakdownSortOrder: 'DESC',
          sortBy: 'totalTokens',
          sortOrder: 'ASC',
        }),
      );
    });

    it('4.3 deberia cargar las opciones de los selectores para el rango', async () => {
      // 1. Arrange 📐
      const options = {
        providers: ['GEMINI'],
        models: [{ aiProvider: 'GEMINI', aiModel: 'gemini-3.6-flash' }],
        flows: [{ id: 'f1', name: 'Notiweb' }],
        nodes: [{ flowId: 'f1', nodeId: 'nodo_ia' }],
      };
      fetchFilterOptions.mockResolvedValue(options);
      const store = useTelemetryStore();

      // 2. Act ⚙️
      await store.loadFilterOptions();

      // 3. Assert 🎯
      expect(fetchFilterOptions).toHaveBeenCalledWith(
        expect.objectContaining({ from: expect.any(String) as string }),
      );
      expect(store.filterOptions).toEqual(options);
    });
  });
});
