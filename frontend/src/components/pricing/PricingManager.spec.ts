// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  ClosePopup,
  Notify,
  QBadge,
  QBtn,
  QForm,
  QIcon,
  QInput,
  QTable,
  QTd,
  QToggle,
  QTooltip,
  QTr,
  Quasar,
} from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@services/pricing.service', () => ({
  fetchPricing: vi.fn(),
  createPricing: vi.fn(),
}));

// `usePanelRefresh` se suscribe al socket: se captura el manejador para poder
// simular el `pricing:updated` que mandaria otro ADMIN.
const pricingHandlers: Array<() => void> = [];

vi.mock('@services/socket-events.service', () => ({
  subscribeToCrudMutations: vi.fn(() => () => undefined),
  subscribeToExecutionEvents: vi.fn(() => () => undefined),
  subscribeToPricingEvents: vi.fn((handler: () => void) => {
    pricingHandlers.push(handler);
    return () => undefined;
  }),
}));

import PricingManager from '@components/pricing/PricingManager.vue';

import { createPricing, fetchPricing } from '@services/pricing.service';

import { LlmProvider } from '@/types/nodes/llm-extractor.types';

import type { ModelPricing } from '@/types/pricing';

const buildRow = (overrides: Partial<ModelPricing> = {}): ModelPricing => ({
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
  ...overrides,
});

const ACTIVE = buildRow();
const HISTORIC = buildRow({ id: '1c8e4a6f-2222-4333-8444-a55566667777', active: false });

const PAYLOAD = {
  aiProvider: LlmProvider.GEMINI,
  aiModel: 'gemini-1.5-pro',
  promptRateUsdPerMTok: 1.5,
  completionRateUsdPerMTok: 6,
  reasoningRateUsdPerMTok: 6,
} as const;

const mountManager = () =>
  mount(PricingManager, {
    global: {
      plugins: [[Quasar, { plugins: { Notify } }]],
      components: { QBadge, QBtn, QForm, QIcon, QInput, QTable, QTd, QToggle, QTooltip, QTr },
      directives: { ClosePopup },
      stubs: {
        PricingDialog: true,
        AuditDetailsMenu: true,
        QPage: { template: '<div><slot /></div>' },
      },
    },
  });

describe('PricingManager', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    pricingHandlers.length = 0;
    vi.mocked(fetchPricing).mockResolvedValue({
      items: [ACTIVE, HISTORIC],
      total: 2,
      limit: 25,
      offset: 0,
    });
  });

  it('1.1 deberia pintar vigente e historico con texto, no solo color', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const wrapper = mountManager();
    await flushPromises();

    // 3. Assert 🎯
    expect(fetchPricing).toHaveBeenCalledWith({ limit: 25, offset: 0 });
    expect(wrapper.text()).toContain('Vigente');
    expect(wrapper.text()).toContain('Histórico');
  });

  it('1.2 deberia ofrecer "actualizar" SOLO en la vigente y ningun boton de baja', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const wrapper = mountManager();
    await flushPromises();

    // 3. Assert 🎯: no hay forma de desactivar una tarifa por separado.
    expect(wrapper.find(`[data-test="pricing-update-${ACTIVE.id}"]`).exists()).toBe(true);
    expect(wrapper.find(`[data-test="pricing-update-${HISTORIC.id}"]`).exists()).toBe(false);
    const buttons = wrapper
      .findAll('button')
      .map((button) => `${button.attributes('aria-label') ?? ''} ${button.text()}`);
    expect(buttons.filter((label) => /desactivar|eliminar|borrar|baja/i.test(label))).toEqual([]);
  });

  it('1.3 guardar deberia pasar por el WarningModal y NO llamar a la API antes', async () => {
    // 1. Arrange 📐
    vi.mocked(createPricing).mockResolvedValue(buildRow({ id: 'nueva' }));
    const wrapper = mountManager();
    await flushPromises();
    const warning = () => wrapper.findComponent({ name: 'WarningModal' });

    // 2. Act ⚙️: el formulario pide guardar...
    wrapper.findComponent({ name: 'PricingDialog' }).vm.$emit('requestSave', PAYLOAD);
    await flushPromises();

    // 3. Assert 🎯: ...y lo que aparece es el aviso, no la peticion.
    expect(warning().props('modelValue')).toBe(true);
    expect(createPricing).not.toHaveBeenCalled();

    // 2. Act ⚙️: solo al confirmar (tras los 5 s, ver WarningModal.spec).
    warning().vm.$emit('confirm');
    await flushPromises();

    // 3. Assert 🎯
    expect(createPricing).toHaveBeenCalledWith(PAYLOAD);
    expect(fetchPricing).toHaveBeenCalledTimes(2);
  });

  it('1.4 cancelar el aviso NO deberia registrar nada', async () => {
    // 1. Arrange 📐
    const wrapper = mountManager();
    await flushPromises();
    wrapper.findComponent({ name: 'PricingDialog' }).vm.$emit('requestSave', PAYLOAD);
    await flushPromises();

    // 2. Act ⚙️
    wrapper.findComponent({ name: 'WarningModal' }).vm.$emit('cancel');
    await flushPromises();

    // 3. Assert 🎯
    expect(createPricing).not.toHaveBeenCalled();
  });

  it('1.5 deberia recargar cuando otro ADMIN registra una tarifa (pricing:updated)', async () => {
    // 1. Arrange 📐
    mountManager();
    await flushPromises();
    expect(pricingHandlers).toHaveLength(1);

    // 2. Act ⚙️
    pricingHandlers[0]?.();
    await flushPromises();

    // 3. Assert 🎯
    expect(fetchPricing).toHaveBeenCalledTimes(2);
  });

  it('1.6 deberia buscar en el servidor con el texto recortado', async () => {
    // 1. Arrange 📐
    const wrapper = mountManager();
    await flushPromises();
    const searchInput = wrapper
      .findAllComponents(QInput)
      .find(
        (input) =>
          input.attributes('data-test') === 'pricing-search' ||
          input.find('[data-test="pricing-search"]').exists(),
      );

    // 2. Act ⚙️: se emite como lo haria QInput tras su `debounce`.
    searchInput?.vm.$emit('update:modelValue', '  gemini  ');
    await flushPromises();

    // 3. Assert 🎯
    expect(fetchPricing).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: 'gemini', offset: 0 }),
    );
  });

  it('1.7 deberia mandar el orden al servidor al pulsar una cabecera', async () => {
    // 1. Arrange 📐
    const wrapper = mountManager();
    await flushPromises();

    // 2. Act ⚙️: lo que QTable emite al ordenar.
    wrapper.findComponent(QTable).vm.$emit('request', {
      pagination: { page: 1, rowsPerPage: 25, sortBy: 'aiModel', descending: true },
    });
    await flushPromises();

    // 3. Assert 🎯
    expect(fetchPricing).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: 'aiModel', sortOrder: 'DESC' }),
    );
  });

  it('1.8 deberia ordenar Limpiar filtros antes de Aplicar, cada uno con su icono', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const wrapper = mountManager();
    await flushPromises();

    // 3. Assert 🎯: misma pareja de acciones que Auditoria e Informes.
    const buttonByLabel = (label: string) =>
      wrapper.findAllComponents(QBtn).find((button) => button.props('label') === label);
    const clear = buttonByLabel('Limpiar filtros');
    const apply = buttonByLabel('Aplicar fechas');
    const actions = wrapper
      .findAll('[data-test^="pricing-filter-"]')
      .map((node) => node.attributes('data-test'));

    expect(clear?.props('icon')).toBe('filter_alt_off');
    expect(apply?.props('icon')).toBe('filter_alt');
    expect(actions.indexOf('pricing-filter-clear')).toBeLessThan(
      actions.indexOf('pricing-filter-apply'),
    );
  });
});
