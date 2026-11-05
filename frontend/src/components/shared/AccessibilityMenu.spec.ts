// @vitest-environment happy-dom
import { createPinia, setActivePinia } from 'pinia';
import { QBtn, QBtnToggle, QOptionGroup, QSeparator, QToggle, QTooltip, Quasar } from 'quasar';
import { beforeEach, describe, expect, it } from 'vitest';

import { flushPromises, mount } from '@vue/test-utils';

import AccessibilityMenu from './AccessibilityMenu.vue';

import { useAccessibilityStore } from '@stores/accessibility.store';

import { AccessibilityPalette } from '@/types/accessibility';

const mountMenu = (props: { includeThemeToggle?: boolean } = {}) =>
  mount(AccessibilityMenu, {
    props,
    global: {
      plugins: [Quasar],
      // El plugin `Quasar` no registra componentes: se declaran a mano.
      components: { QBtn, QBtnToggle, QOptionGroup, QSeparator, QToggle, QTooltip },
      // El QMenu se teletransporta al body: se aplana para ver su contenido.
      stubs: { QMenu: { template: '<div><slot /></div>' }, ThemeToggle: true },
    },
  });

describe('AccessibilityMenu', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-pd-palette');
    setActivePinia(createPinia());
  });

  it('1.1 deberia ser alcanzable y anunciable por teclado', () => {
    // 1. Arrange + 2. Act
    const wrapper = mountMenu();

    // 3. Assert
    expect(wrapper.get('[data-testid="a11y-menu-trigger"]').attributes('aria-label')).toBe(
      'Opciones de accesibilidad',
    );
  });

  it('1.2 deberia aplicar la paleta elegida sobre <html>', async () => {
    // 1. Arrange
    const wrapper = mountMenu();

    // 2. Act
    wrapper
      .findComponent(QOptionGroup)
      .vm.$emit('update:modelValue', AccessibilityPalette.TRITANOPIA);
    await flushPromises();

    // 3. Assert
    expect(document.documentElement.getAttribute('data-pd-palette')).toBe('tritanopia');
  });

  it('1.3 deberia escalar el texto y activar los objetivos amplios', async () => {
    // 1. Arrange
    const wrapper = mountMenu();
    const store = useAccessibilityStore();

    // 2. Act
    wrapper.findComponent(QBtnToggle).vm.$emit('update:modelValue', 1.5);
    const [, largeTargets] = wrapper.findAllComponents(QToggle);
    largeTargets?.vm.$emit('update:modelValue', true);
    await flushPromises();

    // 3. Assert
    expect(store.fontScale).toBe(1.5);
    expect(store.largeTargets).toBe(true);
  });

  it('2.1 deberia alojar el conmutador de tema solo cuando la cabecera lo pide (movil)', () => {
    // 1. Arrange + 2. Act
    const desktop = mountMenu();
    const mobile = mountMenu({ includeThemeToggle: true });

    // 3. Assert
    expect(desktop.find('[data-testid="a11y-theme-row"]').exists()).toBe(false);
    expect(mobile.find('[data-testid="a11y-theme-row"]').exists()).toBe(true);
  });
});
