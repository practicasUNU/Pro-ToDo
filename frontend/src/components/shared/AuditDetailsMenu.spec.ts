// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import {
  QBtn,
  QIcon,
  QItem,
  QItemLabel,
  QItemSection,
  QList,
  QMenu,
  QTooltip,
  Quasar,
} from 'quasar';
import { afterEach, describe, expect, it } from 'vitest';

import AuditDetailsMenu from '@components/shared/AuditDetailsMenu.vue';

import type { AuditableData } from '@/types/auditable';

const AUDIT: AuditableData = {
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-20T16:30:00.000Z',
  createdBy: { id: 'u-1', email: 'admin@unuware.com' },
  updatedBy: null,
};

const mountMenu = (audit: AuditableData = AUDIT) =>
  mount(AuditDetailsMenu, {
    props: { audit, subject: 'Notiweb' },
    attachTo: document.body,
    global: {
      plugins: [Quasar],
      components: { QBtn, QIcon, QItem, QItemLabel, QItemSection, QList, QMenu, QTooltip },
    },
  });

/** El menu se teletransporta al `body`: se busca alli, no en el wrapper. */
const menuElement = (): HTMLElement | null =>
  document.body.querySelector('[data-test="audit-details"]');

describe('AuditDetailsMenu', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('1.1 deberia nombrar el registro en el aria-label del boton', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const wrapper = mountMenu();

    // 3. Assert 🎯: sin el nombre, un lector de pantalla oiria "Ver
    //    auditoria" en cada fila sin saber de cual.
    expect(wrapper.get('[data-test="audit-trigger"]').attributes('aria-label')).toBe(
      'Ver auditoría de Notiweb',
    );
  });

  it('1.2 no deberia mostrar los datos hasta que se pide', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    mountMenu();

    // 3. Assert 🎯: discreto, la tabla no gana contenido.
    expect(menuElement()).toBeNull();
  });

  it('1.3 deberia mostrar autor y fecha de alta y modificacion al abrir', async () => {
    // 1. Arrange 📐
    const wrapper = mountMenu();

    // 2. Act ⚙️
    await wrapper.get('[data-test="audit-trigger"]').trigger('click');
    await flushPromises();

    // 3. Assert 🎯
    const menu = menuElement();
    expect(menu?.querySelector('[data-test="audit-created"]')?.textContent).toContain(
      'admin@unuware.com',
    );
    expect(menu?.querySelector('[data-test="audit-created"] time')?.getAttribute('datetime')).toBe(
      AUDIT.createdAt,
    );
    // Sin autor registrado se dice, no se deja el hueco.
    expect(menu?.querySelector('[data-test="audit-updated"]')?.textContent).toContain(
      'Sin registro',
    );
  });
});
