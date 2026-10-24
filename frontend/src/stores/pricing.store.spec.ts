import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { usePricingStore } from './pricing.store';

import { LlmProvider } from '@/types/nodes/llm-extractor.types';

import type { ModelPricing } from '@/types/pricing';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/pricing.service', () => ({
  fetchPricing: vi.fn(),
  createPricing: vi.fn(),
}));

const pricingService = await import('@services/pricing.service');
const fetchPricing = vi.mocked(pricingService.fetchPricing);
const createPricing = vi.mocked(pricingService.createPricing);

const ROW: ModelPricing = {
  id: '0b7d3f5e-1111-4222-8333-944455556666',
  aiProvider: 'GEMINI',
  aiModel: 'gemini-1.5-pro',
  promptRateUsdPerMTok: 1.25,
  completionRateUsdPerMTok: 5,
  reasoningRateUsdPerMTok: 5,
  validFrom: '2026-10-01T00:00:00.000Z',
  active: true,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  createdBy: null,
  updatedBy: null,
};

const PAYLOAD = {
  aiProvider: LlmProvider.GEMINI,
  aiModel: 'gemini-1.5-pro',
  promptRateUsdPerMTok: 1.5,
  completionRateUsdPerMTok: 6,
  reasoningRateUsdPerMTok: 6,
} as const;

describe('usePricingStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    fetchPricing.mockResolvedValue({ items: [ROW], total: 1, limit: 25, offset: 0 });
  });

  it('1.1 deberia pedir la primera pagina sin filtros ni orden', async () => {
    // 1. Arrange 📐
    const store = usePricingStore();

    // 2. Act ⚙️
    await store.loadPage();

    // 3. Assert 🎯: lo vacio no viaja; el backend ordena por vigencia.
    expect(fetchPricing).toHaveBeenCalledWith({ limit: 25, offset: 0 });
    expect(store.items).toEqual([ROW]);
    expect(store.isLoading).toBe(false);
  });

  it('1.2 deberia enviar busqueda recortada, rango ISO, vigentes y orden', async () => {
    // 1. Arrange 📐
    const store = usePricingStore();
    store.setFilters({
      search: '  gemini  ',
      dateRange: { from: '2026-10-01', to: '2026-10-22' },
      activeOnly: true,
    });
    store.setSort({ sortBy: 'aiModel', descending: true });

    // 2. Act ⚙️
    await store.loadPage();

    // 3. Assert 🎯
    const [query] = fetchPricing.mock.calls[0] ?? [];
    expect(query).toMatchObject({
      search: 'gemini',
      activeOnly: true,
      sortBy: 'aiModel',
      sortOrder: 'DESC',
    });
    expect(query?.from).toBeDefined();
    expect(query?.to).toBeDefined();
  });

  it('1.3 NO deberia enviar un rango a medias', async () => {
    // 1. Arrange 📐: una sola fecha no es un rango; viajaria como filtro absurdo.
    const store = usePricingStore();
    store.setFilters({ dateRange: { from: '2026-10-01', to: '' } });

    // 2. Act ⚙️
    await store.loadPage();

    // 3. Assert 🎯
    expect(fetchPricing.mock.calls[0]?.[0]).not.toHaveProperty('from');
    expect(store.isRangeValid).toBe(false);
  });

  it('1.4 setFilters deberia volver a la primera pagina', () => {
    // 1. Arrange 📐
    const store = usePricingStore();
    store.offset = 50;

    // 2. Act ⚙️
    store.setFilters({ search: 'claude' });

    // 3. Assert 🎯
    expect(store.offset).toBe(0);
  });

  it('1.5 createTariff deberia registrar y RECARGAR, porque el relevo toca dos filas', async () => {
    // 1. Arrange 📐
    createPricing.mockResolvedValue({ ...ROW, id: 'nueva', promptRateUsdPerMTok: 1.5 });
    const store = usePricingStore();

    // 2. Act ⚙️
    await store.createTariff(PAYLOAD);

    // 3. Assert 🎯
    expect(createPricing).toHaveBeenCalledWith(PAYLOAD);
    expect(fetchPricing).toHaveBeenCalledTimes(1);
    expect(store.isSaving).toBe(false);
  });

  it('1.6 deberia propagar el error del alta y apagar isSaving', async () => {
    // 1. Arrange 📐
    createPricing.mockRejectedValue(new Error('409'));
    const store = usePricingStore();

    // 2. Act ⚙️ + 3. Assert 🎯
    await expect(store.createTariff(PAYLOAD)).rejects.toThrow('409');
    expect(store.isSaving).toBe(false);
    expect(fetchPricing).not.toHaveBeenCalled();
  });

  it('1.7 NO deberia exponer ninguna accion de baja ni de edicion en sitio', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const store = usePricingStore() as unknown as Record<string, unknown>;

    // 3. Assert 🎯: el contrato del backend no la tiene, y el store tampoco.
    for (const forbidden of ['deactivateTariff', 'deleteTariff', 'updateTariff', 'removeTariff']) {
      expect(store[forbidden]).toBeUndefined();
    }
  });
});
