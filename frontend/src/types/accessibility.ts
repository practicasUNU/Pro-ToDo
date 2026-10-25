// Preferencias del menu de accesibilidad (WCAG 2.1). Las aplica
// `useAccessibilityStore` sobre <html>; los estilos viven en `css/a11y.scss`.

/** Paleta de color: la de marca, tres para daltonismo y una de alto contraste. */
export enum AccessibilityPalette {
  NORMAL = 'NORMAL',
  DEUTERANOPIA = 'DEUTERANOPIA',
  PROTANOPIA = 'PROTANOPIA',
  TRITANOPIA = 'TRITANOPIA',
  HIGH_CONTRAST = 'HIGH_CONTRAST',
}

/** Espaciado de texto: el de diseno, o el minimo de WCAG 1.4.12. */
export enum TextSpacing {
  NORMAL = 'NORMAL',
  WIDE = 'WIDE',
}

/** Escalas tipograficas ofrecidas; 1 = 100 %. Hasta 150 % sin perder contenido. */
export const FONT_SCALES = [1, 1.125, 1.25, 1.5] as const;

export type FontScale = (typeof FONT_SCALES)[number];

/** Estado persistido del menu. */
export interface AccessibilityPreferences {
  readonly palette: AccessibilityPalette;
  readonly fontScale: FontScale;
  readonly textSpacing: TextSpacing;
  readonly largeTargets: boolean;
}

/** Valor de `data-pd-palette` en <html>; `null` = paleta de marca. */
export const PALETTE_ATTRIBUTE: Readonly<Record<AccessibilityPalette, string | null>> = {
  [AccessibilityPalette.NORMAL]: null,
  [AccessibilityPalette.DEUTERANOPIA]: 'deuteranopia',
  [AccessibilityPalette.PROTANOPIA]: 'protanopia',
  [AccessibilityPalette.TRITANOPIA]: 'tritanopia',
  [AccessibilityPalette.HIGH_CONTRAST]: 'high-contrast',
};

/** Etiquetas del selector, con la condicion que cubre cada paleta. */
export const PALETTE_LABELS: Readonly<Record<AccessibilityPalette, string>> = {
  [AccessibilityPalette.NORMAL]: 'Normal',
  [AccessibilityPalette.DEUTERANOPIA]: 'Deuteranopia (verde)',
  [AccessibilityPalette.PROTANOPIA]: 'Protanopia (rojo)',
  [AccessibilityPalette.TRITANOPIA]: 'Tritanopia (azul-amarillo)',
  [AccessibilityPalette.HIGH_CONTRAST]: 'Alto contraste',
};

export const DEFAULT_ACCESSIBILITY_PREFERENCES: AccessibilityPreferences = {
  palette: AccessibilityPalette.NORMAL,
  fontScale: 1,
  textSpacing: TextSpacing.NORMAL,
  largeTargets: false,
};
