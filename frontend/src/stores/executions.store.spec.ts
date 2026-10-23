import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useExecutionsStore } from './executions.store';

import { ExecutionState } from '@/types/execution';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/fsm-executions.service', () => ({
  fetchExecutions: vi.fn(),
}));

const executionsService = await import('@services/fsm-executions.service');
const fetchExecutions = vi.mocked(executionsService.fetchExecutions);

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
});
