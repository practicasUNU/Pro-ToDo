import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useLogsStore } from './logs.store';

import type { ExecutionLog } from '@/types/logs';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/logs.service', () => ({
  fetchExecutionLog: vi.fn(),
}));

const logsService = await import('@services/logs.service');
const fetchExecutionLog = vi.mocked(logsService.fetchExecutionLog);

const buildLog = (overrides: Partial<ExecutionLog> = {}): ExecutionLog => ({
  executionId: 'e1',
  timestamp: '2026-10-22T08:00:05.000Z',
  level: 'GRAVE',
  stackTrace: 'Error: x',
  rawLog: '{}',
  truncated: false,
  ...overrides,
});

describe('useLogsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('1.1 deberia cargar la traza de la ejecucion', async () => {
    // 1. Arrange 📐
    fetchExecutionLog.mockResolvedValue(buildLog());
    const store = useLogsStore();

    // 2. Act ⚙️
    await store.loadExecutionLog('e1');

    // 3. Assert 🎯
    expect(fetchExecutionLog).toHaveBeenCalledWith('e1');
    expect(store.currentLog?.stackTrace).toBe('Error: x');
    expect(store.isLoading).toBe(false);
  });

  it('1.2 no deberia dejar la traza de otra fila si la peticion falla', async () => {
    // 1. Arrange 📐
    fetchExecutionLog.mockResolvedValueOnce(buildLog({ executionId: 'e1' }));
    fetchExecutionLog.mockRejectedValueOnce(new Error('404'));
    const store = useLogsStore();
    await store.loadExecutionLog('e1');

    // 2. Act ⚙️ + 3. Assert 🎯
    await expect(store.loadExecutionLog('e2')).rejects.toThrow('404');
    expect(store.currentLog).toBeNull();
    expect(store.isLoading).toBe(false);
  });

  it('1.3 clear deberia vaciar la traza', async () => {
    // 1. Arrange 📐
    fetchExecutionLog.mockResolvedValue(buildLog());
    const store = useLogsStore();
    await store.loadExecutionLog('e1');

    // 2. Act ⚙️
    store.clear();

    // 3. Assert 🎯
    expect(store.currentLog).toBeNull();
  });
});
