// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { Notify, QBadge, QBtn, QIcon, QTable, QTd, QTooltip, QTr, Quasar } from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@services/credentials.service', () => ({
  fetchCredentials: vi.fn(),
  fetchCredentialOptions: vi.fn(),
  createCredential: vi.fn(),
  updateCredential: vi.fn(),
  deleteCredential: vi.fn(),
}));

import CredentialsManager from '@components/credentials/CredentialsManager.vue';

import { fetchCredentials } from '@services/credentials.service';

import { CredentialAuthType } from '@/types/credential';
import { AUDIT_FIXTURE } from '@/testing/audit.fixture';

const mountManager = () =>
  mount(CredentialsManager, {
    global: {
      plugins: [[Quasar, { plugins: { Notify } }]],
      components: { QBadge, QBtn, QIcon, QTable, QTd, QTooltip, QTr },
      stubs: {
        CredentialDialog: true,
        SafeDeleteModal: true,
        // Marcador con nombre propio: lo que se comprueba es su POSICION.
        AuditDetailsMenu: { template: '<span data-test="audit-menu-stub" />' },
      },
    },
  });

describe('CredentialsManager', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(fetchCredentials).mockResolvedValue([
      {
        ...AUDIT_FIXTURE,
        id: 'c1',
        name: 'API Drupal',
        authType: CredentialAuthType.BASIC_AUTH,
      },
    ]);
  });

  it('1.1 deberia ordenar las acciones Editar -> Eliminar -> Auditoria', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const wrapper = mountManager();
    await flushPromises();

    // 3. Assert 🎯: Auditoria al extremo derecho, como en el resto de tablas.
    const cell = wrapper.findAll('td').at(-1);
    const order = [...(cell?.element.children ?? [])].map(
      (child) => child.getAttribute('aria-label') ?? child.getAttribute('data-test'),
    );
    expect(order).toEqual(['Editar API Drupal', 'Eliminar API Drupal', 'audit-menu-stub']);
  });
});
