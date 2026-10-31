import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EXECUTIONS_REFRESH_DEBOUNCE_MS, useExecutionsStore } from './executions.store';

import { ExecutionState } from '@/types/execution';

import type { ExecutionSummary } from '@/types/execution';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/fsm-executions.service', () => ({
  fetchExecutions: vi.fn(),
  downloadExecutionsCsv: vi.fn(),
}));

const executionsService = await import('@services/fsm-executions.service');
const fetchExecutions = vi.mocked(executionsService.fetchExecutions);
const downloadExecutionsCsv = vi.mocked(executionsService.downloadExecutionsCsv);

describe('useExecutionsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('1.1 deberia pedir la pagina con los filtros vigentes', async () => {
    // 1. Arrange 📐
    fetchExecutions.mockResolvedValue({ items: [], total: 42, limit: 10, offset: 20 });
    const store = useExecutionsStore();
    store.setFilters({ state: ExecutionState.FALLIDO });

    // 2. Act ⚙️
    await store.fetchPage({ limit: 10, offset: 20 });

    // 3. Assert 🎯
    expect(fetchExecutions).toHaveBeenCalledWith({
      state: ExecutionState.FALLIDO,
      limit: 10,
      offset: 20,
    });
    expect(store.total).toBe(42);
    expect(store.offset).toBe(20);
  });

  it('1.2 cambiar de filtro deberia volver a la primera pagina', () => {
    // 1. Arrange 📐: con la pagina 3 abierta, un filtro nuevo la dejaria vacia.
    const store = useExecutionsStore();
    store.offset = 20;

    // 2. Act ⚙️
    store.setFilters({ state: ExecutionState.EXITOSO });

    // 3. Assert 🎯
    expect(store.offset).toBe(0);
  });

  it('1.3 deberia apagar isLoading aunque la API falle', async () => {
    // 1. Arrange 📐
    fetchExecutions.mockRejectedValue(new Error('500'));
    const store = useExecutionsStore();

    // 2. Act ⚙️ + 3. Assert 🎯
    await expect(store.fetchPage()).rejects.toThrow('500');
    expect(store.isLoading).toBe(false);
  });

  it('1.4 deberia mandar el orden al servidor y no mandarlo sin criterio', async () => {
    // 1. Arrange 📐: el orden es del historial ENTERO, no de la pagina visible.
    fetchExecutions.mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0 });
    const store = useExecutionsStore();

    // 2. Act ⚙️
    await store.fetchPage();
    store.setSort({ sortBy: 'startedAt', descending: false });
    await store.fetchPage();

    // 3. Assert 🎯
    expect(fetchExecutions.mock.calls[0]?.[0]).not.toHaveProperty('sortBy');
    expect(fetchExecutions.mock.calls[1]?.[0]).toMatchObject({
      sortBy: 'startedAt',
      sortOrder: 'ASC',
    });
  });

  describe('2. Tiempo real (execution:updated)', () => {
    const FLOW_ID = '7c0e5c2a-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
    const ROW: ExecutionSummary = {
      executionId: 'e1d2c3b4-a5f6-4789-8abc-def012345678',
      flowId: FLOW_ID,
      state: ExecutionState.PAUSADO,
      activeCursor: 'nodo_ia',
      logFilePath: null,
      failureReason: null,
      startedAt: '2026-10-26T08:00:00.000Z',
      updatedAt: '2026-10-26T08:00:00.000Z',
      hasAlerts: true,
    };

    const loadedStore = async () => {
      fetchExecutions.mockResolvedValue({ items: [ROW], total: 1, limit: 10, offset: 0 });
      const store = useExecutionsStore();
      await store.fetchPage();
      fetchExecutions.mockClear();
      return store;
    };

    it('2.1 deberia repintar la fila de PAUSADO a EN_PROCESO sin recargar', async () => {
      // 1. Arrange 📐
      const store = await loadedStore();

      // 2. Act ⚙️
      store.applyExecutionUpdate({
        executionId: ROW.executionId,
        flowId: FLOW_ID,
        emittedAt: '2026-10-26T08:05:00.000Z',
        state: ExecutionState.EN_PROCESO,
        activeCursor: 'nodo_ia',
      });

      // 3. Assert 🎯: EN_PROCESO no trae datos nuevos que releer.
      expect(store.items[0]?.state).toBe(ExecutionState.EN_PROCESO);
      expect(store.items[0]?.updatedAt).toBe('2026-10-26T08:05:00.000Z');
      expect(fetchExecutions).not.toHaveBeenCalled();
    });

    it('2.2 deberia releer una vez la primera pagina ante una ejecucion nueva', async () => {
      // 1. Arrange 📐
      vi.useFakeTimers();
      const store = await loadedStore();
      const event = {
        executionId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
        flowId: FLOW_ID,
        emittedAt: '2026-10-26T08:06:00.000Z',
        state: ExecutionState.EN_PROCESO,
        activeCursor: 'trigger',
      };

      // 2. Act ⚙️: rafaga de dos eventos.
      store.applyExecutionUpdate(event);
      store.applyExecutionUpdate({ ...event, state: ExecutionState.EXITOSO, activeCursor: null });
      await vi.advanceTimersByTimeAsync(EXECUTIONS_REFRESH_DEBOUNCE_MS);
      vi.useRealTimers();

      // 3. Assert 🎯
      expect(fetchExecutions).toHaveBeenCalledTimes(1);
    });

    it('2.3 no deberia pedir nada si el historial nunca se cargo', () => {
      // 1. Arrange 📐
      const store = useExecutionsStore();

      // 2. Act ⚙️
      store.applyExecutionUpdate({
        executionId: ROW.executionId,
        flowId: FLOW_ID,
        emittedAt: '2026-10-26T08:05:00.000Z',
        state: ExecutionState.EXITOSO,
        activeCursor: null,
      });

      // 3. Assert 🎯
      expect(store.items).toEqual([]);
      expect(fetchExecutions).not.toHaveBeenCalled();
    });
  });

  describe('3. Exportacion CSV', () => {
    const FLOW_ID = '7c0e5c2a-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
    const CSV_BLOB = new Blob(['Ejecución;Flujo'], { type: 'text/csv' });

    it('should filter exported execution history report dataset based on active UI filter parameters', async () => {
      // 1. Arrange 📐: filtros aplicados, orden elegido y la pagina 3 abierta.
      fetchExecutions.mockResolvedValue({ items: [], total: 60, limit: 10, offset: 20 });
      downloadExecutionsCsv.mockResolvedValue(CSV_BLOB);
      const store = useExecutionsStore();
      store.setFilters({
        state: ExecutionState.FALLIDO,
        flowId: FLOW_ID,
        from: '2026-10-01',
        to: '2026-10-22',
      });
      store.setSort({ sortBy: 'updatedAt', descending: true });
      await store.fetchPage({ limit: 10, offset: 20 });

      // 2. Act ⚙️
      const blob = await store.exportHistory();

      // 3. Assert 🎯: EXACTAMENTE los filtros aplicados y el orden, sin la
      //    ventana de pagina: el informe trae todas las filas, no la pagina 3.
      expect(downloadExecutionsCsv).toHaveBeenCalledTimes(1);
      expect(downloadExecutionsCsv).toHaveBeenCalledWith({
        state: ExecutionState.FALLIDO,
        flowId: FLOW_ID,
        from: '2026-10-01',
        to: '2026-10-22',
        sortBy: 'updatedAt',
        sortOrder: 'DESC',
      });
      const [query] = downloadExecutionsCsv.mock.calls[0] ?? [];
      expect(query).not.toHaveProperty('limit');
      expect(query).not.toHaveProperty('offset');
      expect(blob).toBe(CSV_BLOB);
    });

    it('3.2 sin filtros ni orden no deberia enviar ningun parametro', async () => {
      // 1. Arrange 📐
      downloadExecutionsCsv.mockResolvedValue(CSV_BLOB);
      const store = useExecutionsStore();

      // 2. Act ⚙️
      await store.exportHistory();

      // 3. Assert 🎯
      expect(downloadExecutionsCsv).toHaveBeenCalledWith({});
    });

    it('3.3 deberia marcar isExporting mientras descarga y apagarlo al terminar', async () => {
      // 1. Arrange 📐
      let resolveDownload: (blob: Blob) => void = () => undefined;
      downloadExecutionsCsv.mockReturnValue(
        new Promise<Blob>((resolve) => {
          resolveDownload = resolve;
        }),
      );
      const store = useExecutionsStore();

      // 2. Act ⚙️
      const pending = store.exportHistory();
      const duringDownload = store.isExporting;
      resolveDownload(CSV_BLOB);
      await pending;

      // 3. Assert 🎯
      expect(duringDownload).toBe(true);
      expect(store.isExporting).toBe(false);
    });

    it('3.4 deberia propagar el error y apagar isExporting aunque la API falle', async () => {
      // 1. Arrange 📐: el mensaje lo decide el componente, no el store.
      downloadExecutionsCsv.mockRejectedValue(new Error('500'));
      const store = useExecutionsStore();

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(store.exportHistory()).rejects.toThrow('500');
      expect(store.isExporting).toBe(false);
    });
  });
});
