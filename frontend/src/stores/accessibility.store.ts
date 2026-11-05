import { defineStore, acceptHMRUpdate } from 'pinia';
import { ref } from 'vue';

import {
  AccessibilityPalette,
  DEFAULT_ACCESSIBILITY_PREFERENCES,
  FONT_SCALES,
  PALETTE_ATTRIBUTE,
  TextSpacing,
} from '@/types/accessibility';

import type { AccessibilityPreferences, FontScale } from '@/types/accessibility';

// Preferencias de accesibilidad visual (WCAG 2.1). Sigue el patron de
// `theme.store.ts`: persistencia en localStorage con guarda, y aplicacion
// directa sobre <html> en vez de un estado que cada componente tenga que leer.
// Los estilos que reaccionan a esas marcas viven en `css/a11y.scss`.

const STORAGE_KEY = 'proto-do:a11y';

/** Clases sobre <html>; las lee `a11y.scss`. */
const TEXT_SPACING_CLASS = 'pd-text-spacing--wide';
const LARGE_TARGETS_CLASS = 'pd-large-targets';

const isPalette = (value: unknown): value is AccessibilityPalette =>
  Object.values(AccessibilityPalette).includes(value as AccessibilityPalette);

const isFontScale = (value: unknown): value is FontScale =>
  FONT_SCALES.includes(value as FontScale);

/**
 * Lee las preferencias guardadas campo a campo: un valor corrupto o de una
 * version anterior cae a su defecto sin tumbar los demas.
 */
const readStored = (): AccessibilityPreferences => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    const stored =
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};

    return {
      palette: isPalette(stored.palette)
        ? stored.palette
        : DEFAULT_ACCESSIBILITY_PREFERENCES.palette,
      fontScale: isFontScale(stored.fontScale)
        ? stored.fontScale
        : DEFAULT_ACCESSIBILITY_PREFERENCES.fontScale,
      textSpacing:
        stored.textSpacing === TextSpacing.WIDE
          ? TextSpacing.WIDE
          : DEFAULT_ACCESSIBILITY_PREFERENCES.textSpacing,
      largeTargets: stored.largeTargets === true,
    };
  } catch {
    return DEFAULT_ACCESSIBILITY_PREFERENCES;
  }
};

export const useAccessibilityStore = defineStore('accessibility', () => {
  const initial = readStored();

  const palette = ref<AccessibilityPalette>(initial.palette);
  const fontScale = ref<FontScale>(initial.fontScale);
  const textSpacing = ref<TextSpacing>(initial.textSpacing);
  const largeTargets = ref<boolean>(initial.largeTargets);

  const persist = (): void => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          palette: palette.value,
          fontScale: fontScale.value,
          textSpacing: textSpacing.value,
          largeTargets: largeTargets.value,
        }),
      );
    } catch {
      // Sin almacenamiento (incognito, bloqueado): la preferencia vive en memoria.
    }
  };

  /** Traslada el estado a <html>, que es donde lo leen los estilos. */
  const applyToDocument = (): void => {
    if (typeof document === 'undefined') return;

    const root = document.documentElement;
    const attribute = PALETTE_ATTRIBUTE[palette.value];

    if (attribute === null) {
      root.removeAttribute('data-pd-palette');
    } else {
      root.setAttribute('data-pd-palette', attribute);
    }

    root.style.setProperty('--pd-font-scale', String(fontScale.value));
    root.classList.toggle(TEXT_SPACING_CLASS, textSpacing.value === TextSpacing.WIDE);
    root.classList.toggle(LARGE_TARGETS_CLASS, largeTargets.value);
  };

  const commit = (): void => {
    applyToDocument();
    persist();
  };

  const setPalette = (value: AccessibilityPalette): void => {
    palette.value = value;
    commit();
  };

  const setFontScale = (value: FontScale): void => {
    fontScale.value = value;
    commit();
  };

  const setTextSpacing = (value: TextSpacing): void => {
    textSpacing.value = value;
    commit();
  };

  const setLargeTargets = (value: boolean): void => {
    largeTargets.value = value;
    commit();
  };

  /** Vuelve a la configuracion de diseno. */
  const reset = (): void => {
    palette.value = DEFAULT_ACCESSIBILITY_PREFERENCES.palette;
    fontScale.value = DEFAULT_ACCESSIBILITY_PREFERENCES.fontScale;
    textSpacing.value = DEFAULT_ACCESSIBILITY_PREFERENCES.textSpacing;
    largeTargets.value = DEFAULT_ACCESSIBILITY_PREFERENCES.largeTargets;
    commit();
  };

  // Igual que el tema: el cuerpo del setup store corre una vez, en el primer
  // uso (el encabezado), antes del primer pintado -> sin parpadeo.
  applyToDocument();

  return {
    palette,
    fontScale,
    textSpacing,
    largeTargets,
    setPalette,
    setFontScale,
    setTextSpacing,
    setLargeTargets,
    reset,
    applyToDocument,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAccessibilityStore, import.meta.hot));
}
