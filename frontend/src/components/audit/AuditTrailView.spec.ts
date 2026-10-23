// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  Notify,
  QBadge,
  QBtn,
  QForm,
  QIcon,
  QInput,
  QSelect,
  QTable,
  QTd,
  QTooltip,
  QTr,
  Quasar,
} from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@services/audit.service', () => ({
  fetchAuditEvents: vi.fn(),
  downloadAuditReport: vi.fn(),
}));

vi.mock('@services/users.service', () => ({
  fetchUsers: vi.fn().mockResolvedValue([]),
}));

import AuditTrailView from '@components/audit/AuditTrailView.vue';
import { useAuditStore } from '@stores/audit.store';

import { fetchAuditEvents } from '@services/audit.service';

import { AuditActionValue } from '@/types/audit';

import type { AuditEvent } from '@/types/audit';

const buildEvent = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  id: 'evt-1',
  createdAt: '2026-10-22T08:30:00.000Z',
  userId: '3f1c2b64-8a5e-4c2f-9d3a-7b6e5f4c1a20',
  userEmail: 'admin@unuware.com',
  action: AuditActionValue.LOGIN_FAILED,
  affectedTable: 'usuarios',
  recordId: null,
  previousData: null,
  newData: { email: 'intruso@unuware.com' },
  sourceIp: '10.0.0.9',
  ...overrides,
});

const mountView = () =>
  mount(AuditTrailView, {
    global: {
      plugins: [[Quasar, { plugins: { Notify } }]],
      components: { QBadge, QBtn, QForm, QIcon, QInput, QSelect, QTable, QTd, QTooltip, QTr },
      stubs: { AuditEventDetailsModal: true },
    },
  });

describe('AuditTrailView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('1.1 deberia cargar la primera pagina y pintar la accion con texto', async () => {
    // 1. Arrange 📐
    vi.mocked(fetchAuditEvents).mockResolvedValue({
      items: [buildEvent()],
      total: 1,
      limit: 25,
      offset: 0,
    });

    // 2. Act ⚙️
    const wrapper = mountView();
    await flushPromises();

    // 3. Assert 🎯
    expect(fetchAuditEvents).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }));
    const badge = wrapper.get('[data-test="audit-action-evt-1"]');
    expect(badge.text()).toBe('Inicio de sesión fallido');
    expect(badge.classes()).toContain('pd-badge--failed');
    expect(wrapper.text()).toContain('10.0.0.9');
  });

  it('1.2 aplicar deberia volcar los filtros al store y volver a la primera pagina', async () => {
    // 1. Arrange 📐
    vi.mocked(fetchAuditEvents).mockResolvedValue({ items: [], total: 0, limit: 25, offset: 0 });
    const wrapper = mountView();
    await flushPromises();
    const store = useAuditStore();
    store.offset = 50;
    vi.mocked(fetchAuditEvents).mockClear();

    // 2. Act ⚙️
    await wrapper.getComponent({ name: 'QForm' }).trigger('submit');
    await flushPromises();

    // 3. Assert 🎯
    expect(fetchAuditEvents).toHaveBeenCalledTimes(1);
    expect(fetchAuditEvents).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }));
  });

  it('1.3 deberia abrir el detalle del evento al pulsar su boton', async () => {
    // 1. Arrange 📐
    vi.mocked(fetchAuditEvents).mockResolvedValue({
      items: [buildEvent()],
      total: 1,
      limit: 25,
      offset: 0,
    });
    const wrapper = mountView();
    await flushPromises();

    // 2. Act ⚙️
    await wrapper.get('[data-test="audit-details-evt-1"]').trigger('click');

    // 3. Assert 🎯
    const modal = wrapper.findComponent({ name: 'AuditEventDetailsModal' });
    expect(modal.props('modelValue')).toBe(true);
    expect(modal.props('event')).toMatchObject({ id: 'evt-1' });
  });
});
