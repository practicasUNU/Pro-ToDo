// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import {
  ClosePopup,
  QBtn,
  QCard,
  QCardActions,
  QCardSection,
  QDialog,
  QIcon,
  QItem,
  QList,
  Quasar,
} from 'quasar';
import { describe, expect, it } from 'vitest';

import DrupalPublishSuccessModal from '@components/workflows/DrupalPublishSuccessModal.vue';

const PUBLISHED_URL = 'https://portal.example/noticias/innovacion';

/**
 * Abre el dialogo como lo haria el plugin `$q.dialog`, que llama a `show()`.
 */
const openModal = async (wrapper: ReturnType<typeof mount>): Promise<void> => {
  (wrapper.findComponent(QDialog).vm as unknown as { show: () => void }).show();
  await flushPromises();
};

/**
 * Monta el modal fuera del plugin de dialogos. `QDialog` teletransporta su
 * contenido al `body`, asi que las aserciones se hacen sobre el documento.
 */
const mountModal = (props: Record<string, unknown> = {}): ReturnType<typeof mount> =>
  mount(DrupalPublishSuccessModal, {
    props: { publishedUrl: PUBLISHED_URL, ...props },
    global: {
      plugins: [Quasar],
      components: { QBtn, QCard, QCardActions, QCardSection, QDialog, QIcon, QItem, QList },
      directives: { ClosePopup },
    },
    attachTo: document.body,
  });

const query = (selector: string): HTMLElement | null =>
  document.body.querySelector<HTMLElement>(selector);

describe('DrupalPublishSuccessModal', () => {
  it('1. deberia abrir un dialogo persistente con el titulo de exito', async () => {
    // Arrange 📐 & Act ⚙️
    const wrapper = mountModal();
    await openModal(wrapper);

    // Assert 🎯
    const dialog = wrapper.findComponent(QDialog);
    expect(dialog.props('persistent')).toBe(true);
    expect(query('[data-test="drupal-publish-modal"]')?.textContent).toContain(
      'Publicación Exitosa en Drupal',
    );
    wrapper.unmount();
  });

  it('2. deberia enlazar la pagina publicada en una pestana nueva sin opener', async () => {
    // Arrange 📐 & Act ⚙️
    const wrapper = mountModal({ exitPage: '/noticias/innovacion', flowName: 'Notiweb' });
    await openModal(wrapper);

    // Assert 🎯
    const link = query('[data-test="drupal-publish-link"]');
    expect(link?.getAttribute('href')).toBe(PUBLISHED_URL);
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(query('[data-test="drupal-publish-exit-page"]')?.textContent).toBe(
      '/noticias/innovacion',
    );
    expect(query('[data-test="drupal-publish-close"]')?.textContent).toContain(
      'Entendido y Cerrar',
    );
    wrapper.unmount();
  });

  it('3. deberia enlazar TODAS las paginas de un lote, en orden', async () => {
    // Arrange 📐 & Act ⚙️: un boletin de tres noticias.
    const urls = [
      'https://portal.example/n-1',
      'https://portal.example/n-2',
      'https://portal.example/n-3',
    ];
    const wrapper = mountModal({ publishedUrl: urls[0], publishedUrls: urls });
    await openModal(wrapper);

    // Assert 🎯
    const links = [...document.body.querySelectorAll('[data-test="drupal-publish-link"]')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual(urls);
    expect(links.every((link) => link.getAttribute('rel') === 'noopener noreferrer')).toBe(true);
    expect(query('[data-test="drupal-publish-count"]')?.textContent).toContain('(3)');
    wrapper.unmount();
  });

  it('4. deberia mostrar un solo enlace si el lote trae una sola URL', async () => {
    // Arrange 📐 & Act ⚙️
    const wrapper = mountModal({ publishedUrls: [PUBLISHED_URL] });
    await openModal(wrapper);

    // Assert 🎯
    expect(document.body.querySelectorAll('[data-test="drupal-publish-link"]')).toHaveLength(1);
    expect(query('[data-test="drupal-publish-count"]')).toBeNull();
    wrapper.unmount();
  });
});
