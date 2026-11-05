import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuditStore } from './audit.store';

import { AuditActionValue, AuditTableValue } from '@/types/audit';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/audit.service', () => ({
  fetchAuditEvents: vi.fn(),
  downloadAuditReport: vi.fn(),
}));

const auditService = await import('@services/audit.service');
const fetchAuditEvents = vi.mocked(auditService.fetchAuditEvents);
const downloadAuditReport = vi.mocked(auditService.downloadAuditReport);

const USER_ID = '3f1c2b64-8a5e-4c2f-9d3a-7b6e5f4c1a20';

describe('useAuditStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('1.1 deberia pedir la pagina con el rango y solo los filtros elegidos', async () => {
    // 1. Arrange 📐
    fetchAuditEvents.mockResolvedValue({ items: [], total: 40, limit: 10, offset: 20 });
    const store = useAuditStore();
    store.setDateRange({ from: '2026-10-01', to: '2026-10-22' });
    store.setFilters({ action: AuditActionValue.LOGIN_FAILED });

    // 2. Act ⚙️
    await store.loadPage({ limit: 10, offset: 20 });

    // 3. Assert 🎯: los filtros a `null` no viajan.
    const [query] = fetchAuditEvents.mock.calls[0] ?? [];
    expect(query).toMatchObject({
      action: AuditActionValue.LOGIN_FAILED,
      limit: 10,
      offset: 20,
    });
    expect(query).not.toHaveProperty('userId');
    expect(query).not.toHaveProperty('affectedTable');
    expect(query?.from).toBeDefined();
    expect(store.total).toBe(40);
    expect(store.offset).toBe(20);
    expect(store.isLoading).toBe(false);
  });

  it('1.2 setFilters deberia volver a la primera pagina', () => {
    // 1. Arrange 📐
    const store = useAuditStore();
    store.offset = 50;

    // 2. Act ⚙️
    store.setFilters({ userId: USER_ID, affectedTable: AuditTableValue.USERS });

    // 3. Assert 🎯
    expect(store.offset).toBe(0);
    expect(store.query).toMatchObject({ userId: USER_ID, affectedTable: 'usuarios' });
  });

  it('1.3 resetFilters deberia vaciar los filtros', () => {
    // 1. Arrange 📐
    const store = useAuditStore();
    store.setFilters({ userId: USER_ID });

    // 2. Act ⚙️
    store.resetFilters();

    // 3. Assert 🎯
    expect(store.filters).toEqual({ userId: null, action: null, affectedTable: null });
  });

  it('1.4 exportReport deberia pasar el formato y los filtros y apagar el indicador', async () => {
    // 1. Arrange 📐
    const blob = new Blob(['%PDF']);
    downloadAuditReport.mockResolvedValue(blob);
    const store = useAuditStore();
    store.setFilters({ userId: USER_ID });

    // 2. Act ⚙️
    const result = await store.exportReport('pdf');

    // 3. Assert 🎯
    expect(result).toBe(blob);
    expect(downloadAuditReport).toHaveBeenCalledWith(
      'pdf',
      expect.objectContaining({ userId: USER_ID }),
    );
    expect(store.exporting.pdf).toBe(false);
  });

  it('1.5 deberia propagar el error y apagar isLoading', async () => {
    // 1. Arrange 📐
    fetchAuditEvents.mockRejectedValue(new Error('403'));
    const store = useAuditStore();

    // 2. Act ⚙️ + 3. Assert 🎯
    await expect(store.loadPage()).rejects.toThrow('403');
    expect(store.isLoading).toBe(false);
  });

  it('1.6 deberia mandar el orden al servidor', async () => {
    // 1. Arrange 📐
    fetchAuditEvents.mockResolvedValue({ items: [], total: 0, limit: 25, offset: 0 });
    const store = useAuditStore();
    store.setSort({ sortBy: 'user', descending: false });

    // 2. Act ⚙️
    await store.loadPage();

    // 3. Assert 🎯
    expect(fetchAuditEvents.mock.calls[0]?.[0]).toMatchObject({
      sortBy: 'user',
      sortOrder: 'ASC',
    });
  });
});
