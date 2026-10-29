// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import {
  QBadge,
  QBtn,
  QCard,
  QCardActions,
  QCardSection,
  QDialog,
  QExpansionItem,
  QIcon,
  QMarkupTable,
  Quasar,
} from 'quasar';
import { afterEach, describe, expect, it } from 'vitest';

import AuditEventDetailsModal from '@components/audit/AuditEventDetailsModal.vue';

import { AuditActionValue } from '@/types/audit';

import type { AuditEvent } from '@/types/audit';

const buildEvent = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  id: 'evt-1',
  createdAt: '2026-10-22T08:30:00.000Z',
  userId: '3f1c2b64-8a5e-4c2f-9d3a-7b6e5f4c1a20',
  userEmail: 'admin@unuware.com',
  action: AuditActionValue.ROLE_CHANGE,
  affectedTable: 'usuarios',
  recordId: 'b27d9e10-4c3f-4a8b-9f21-6d5e4c3b2a19',
  previousData: { email: 'e@unuware.com', role: 'EDITOR' },
  newData: { email: 'e@unuware.com', role: 'ADMIN' },
  sourceIp: '192.168.1.20',
  ...overrides,
});

const mountModal = (event: AuditEvent | null) =>
  mount(AuditEventDetailsModal, {
    props: { modelValue: true, event },
    attachTo: document.body,
    global: {
      plugins: [Quasar],
      components: {
        QBadge,
        QBtn,
        QCard,
        QCardActions,
        QCardSection,
        QDialog,
        QExpansionItem,
        QIcon,
        QMarkupTable,
      },
    },
  });

/** El dialogo se teletransporta al `body`: se busca alli, no en el wrapper. */
const find = (selector: string): Element | null => document.body.querySelector(selector);

describe('AuditEventDetailsModal', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('1.1 deberia mostrar actor y el campo modificado con su valor antes y despues', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    mountModal(buildEvent());
    await flushPromises();

    // 3. Assert 🎯: solo cambia `role`; el correo, identico, no aparece.
    expect(find('[data-test="audit-detail-user"]')?.textContent).toContain('admin@unuware.com');
    const rows = document.body.querySelectorAll('[data-test="audit-diff-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('role');
    expect(rows[0]?.querySelector('[data-test="audit-diff-before"]')?.textContent?.trim()).toBe(
      'EDITOR',
    );
    expect(rows[0]?.querySelector('[data-test="audit-diff-after"]')?.textContent?.trim()).toBe(
      'ADMIN',
    );
  });

  it('1.2 deberia aplanar los objetos anidados hasta el campo que cambio', async () => {
    // 1. Arrange 📐: se edita el prompt de un nodo OCR dentro del esquema.
    mountModal(
      buildEvent({
        action: AuditActionValue.UPDATE,
        affectedTable: 'flujos',
        previousData: {
          pipelineSchema: { nodes: [{ nodeId: 'ocr', params: { customPrompt: 'Antes' } }] },
        },
        newData: {
          pipelineSchema: { nodes: [{ nodeId: 'ocr', params: { customPrompt: 'Despues' } }] },
        },
      }),
    );
    await flushPromises();

    // 3. Assert 🎯
    const rows = document.body.querySelectorAll('[data-test="audit-diff-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('pipelineSchema.nodes[0].params.customPrompt');
    expect(rows[0]?.textContent).not.toContain('[object Object]');
  });

  it('1.2b deberia mostrar un guion como valor anterior en un alta', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    mountModal(buildEvent({ action: AuditActionValue.LOGIN, previousData: null }));
    await flushPromises();

    // 3. Assert 🎯
    const before = document.body.querySelectorAll('[data-test="audit-diff-before"]');
    expect([...before].every((cell) => cell.textContent?.trim() === '—')).toBe(true);
  });

  it('1.3 Cerrar deberia emitir update:modelValue a false', async () => {
    // 1. Arrange 📐
    const wrapper = mountModal(buildEvent());
    await flushPromises();

    // 2. Act ⚙️
    (find('[data-test="audit-detail-close"]') as HTMLElement).click();
    await wrapper.vm.$nextTick();

    // 3. Assert 🎯
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false]);
  });
});
