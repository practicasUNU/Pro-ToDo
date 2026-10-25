// Contraste WCAG 2.1 entre dos colores opacos (#rgb o #rrggbb). Helper puro:
// lo usa la prueba que vigila que cada badge de estado supere 4.5:1 en todas
// las paletas, y sirve igual para cualquier par relleno/texto futuro.

/** Componente sRGB (0-255) linealizado, segun la definicion de WCAG. */
const linearize = (channel: number): number => {
  const value = channel / 255;

  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

/** `#abc` o `#aabbcc` a sus tres canales; lanza ante cualquier otra forma. */
const parseHex = (hex: string): readonly [number, number, number] => {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());

  if (match?.[1] === undefined) {
    throw new Error(`Color no soportado: "${hex}" (solo #rgb o #rrggbb opacos)`);
  }

  const digits =
    match[1].length === 3
      ? match[1]
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : match[1];

  return [0, 2, 4].map((start) => parseInt(digits.slice(start, start + 2), 16)) as unknown as [
    number,
    number,
    number,
  ];
};

/** Luminancia relativa (0 negro, 1 blanco). */
export const relativeLuminance = (hex: string): number => {
  const [r, g, b] = parseHex(hex);

  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
};

/** Ratio de contraste entre dos colores, de 1 a 21. */
export const contrastRatio = (first: string, second: string): number => {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort(
    (a, b) => b - a,
  ) as [number, number];

  return (lighter + 0.05) / (darker + 0.05);
};

/** Umbral AA para texto normal. */
export const WCAG_AA_NORMAL_TEXT = 4.5;
