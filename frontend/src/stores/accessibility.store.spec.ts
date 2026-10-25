// @vitest-environment happy-dom
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAccessibilityStore } from './accessibility.store';

import { AccessibilityPalette, TextSpacing } from '@/types/accessibility';

const STORAGE_KEY = 'proto-do:a11y';
const root = (): HTMLElement => document.documentElement;

describe('useAccessibilityStore', () => {
  beforeEach(() => {
    localStorage.clear();
    root().removeAttribute('data-pd-palette');
    root().className = '';
    root().style.removeProperty('--pd-font-scale');
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1.1 deberia arrancar con la configuracion de diseno', () => {
    // 1. Arrange + 2. Act
    const store = useAccessibilityStore();

    // 3. Assert
    expect(store.palette).toBe(AccessibilityPalette.NORMAL);
    expect(root().hasAttribute('data-pd-palette')).toBe(false);
    expect(root().style.getPropertyValue('--pd-font-scale')).toBe('1');
  });

  it('1.2 deberia aplicar la paleta, la escala y las clases sobre <html>', () => {
    // 1. Arrange
    const store = useAccessibilityStore();

    // 2. Act
    store.setPalette(AccessibilityPalette.DEUTERANOPIA);
    store.setFontScale(1.25);
    store.setTextSpacing(TextSpacing.WIDE);
    store.setLargeTargets(true);

    // 3. Assert
    expect(root().getAttribute('data-pd-palette')).toBe('deuteranopia');
    expect(root().style.getPropertyValue('--pd-font-scale')).toBe('1.25');
    expect(root().classList.contains('pd-text-spacing--wide')).toBe(true);
    expect(root().classList.contains('pd-large-targets')).toBe(true);
  });

  it('1.3 deberia persistir y recuperar las preferencias en una sesion nueva', () => {
    // 1. Arrange
    useAccessibilityStore().setPalette(AccessibilityPalette.HIGH_CONTRAST);

    // 2. Act: otra pestana, otro Pinia.
    setActivePinia(createPinia());
    const store = useAccessibilityStore();

    // 3. Assert
    expect(store.palette).toBe(AccessibilityPalette.HIGH_CONTRAST);
    expect(root().getAttribute('data-pd-palette')).toBe('high-contrast');
  });

  it('1.4 deberia descartar campo a campo lo guardado que no es valido', () => {
    // 1. Arrange: una escala que no se ofrece y una paleta inexistente.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ palette: 'SEPIA', fontScale: 3, textSpacing: TextSpacing.WIDE }),
    );

    // 2. Act
    const store = useAccessibilityStore();

    // 3. Assert
    expect(store.palette).toBe(AccessibilityPalette.NORMAL);
    expect(store.fontScale).toBe(1);
    expect(store.textSpacing).toBe(TextSpacing.WIDE);
  });

  it('1.5 deberia funcionar sin almacenamiento disponible', () => {
    // 1. Arrange: modo incognito o almacenamiento bloqueado.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    // 2. Act
    const store = useAccessibilityStore();
    store.setPalette(AccessibilityPalette.TRITANOPIA);

    // 3. Assert: la preferencia vive en memoria y se aplica igual.
    expect(root().getAttribute('data-pd-palette')).toBe('tritanopia');
  });

  it('1.6 deberia restablecer todo con reset', () => {
    // 1. Arrange
    const store = useAccessibilityStore();
    store.setPalette(AccessibilityPalette.PROTANOPIA);
    store.setLargeTargets(true);

    // 2. Act
    store.reset();

    // 3. Assert
    expect(root().hasAttribute('data-pd-palette')).toBe(false);
    expect(root().classList.contains('pd-large-targets')).toBe(false);
  });
});
