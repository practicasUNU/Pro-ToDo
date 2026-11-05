import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WCAG_AA_NORMAL_TEXT, contrastRatio, relativeLuminance } from './color-contrast';

// La prueba lee las hojas REALES: si alguien cambia un token o el color de un
// badge y rompe el contraste, falla aqui y no en la retina de un usuario.

const readCss = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../css/${name}`, import.meta.url)), 'utf8');

/** Bloque de primer nivel: su selector y SOLO sus declaraciones directas. */
interface CssBlock {
  readonly selector: string;
  readonly declarations: Readonly<Record<string, string>>;
}

/** Escaner minimo de bloques de primer nivel, ignorando los anidados. */
const parseTopLevelBlocks = (css: string): CssBlock[] => {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const blocks: CssBlock[] = [];
  let depth = 0;
  let selectorStart = 0;
  let selector = '';
  let body = '';

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (char === '{') {
      if (depth === 0) {
        selector = source.slice(selectorStart, index).trim();
        body = '';
      }
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const declarations: Record<string, string> = {};

        for (const match of body.matchAll(/(--?[\w-]+|[\w-]+)\s*:\s*([^;]+);/g)) {
          declarations[match[1] ?? ''] = (match[2] ?? '').trim();
        }

        blocks.push({ selector, declarations });
        selectorStart = index + 1;
      }
    } else if (depth === 1) {
      body += char;
    } else if (depth === 0 && char === ';') {
      selectorStart = index + 1;
    }
  }

  return blocks;
};

const APP = parseTopLevelBlocks(readCss('app.scss'));
const A11Y = parseTopLevelBlocks(readCss('a11y.scss'));

/** Fusiona las variables de los bloques cuyo selector cumple el predicado. */
const tokensOf = (
  blocks: readonly CssBlock[],
  matches: (selector: string) => boolean,
): Record<string, string> =>
  Object.assign(
    {},
    ...blocks
      .filter((block) => matches(block.selector))
      .map((block) =>
        Object.fromEntries(
          Object.entries(block.declarations).filter(([name]) => name.startsWith('--')),
        ),
      ),
  ) as Record<string, string>;

const NORMAL_HTML = tokensOf(APP, (selector) => selector === ':root');
const NORMAL_BODY_DARK = tokensOf(APP, (selector) => selector === 'body.body--dark');

const PALETTES = ['deuteranopia', 'protanopia', 'tritanopia', 'high-contrast'] as const;

/**
 * Tokens efectivos de una paleta y un modo, con la misma cascada que el
 * navegador: lo de <html> (marca y paleta) y, en oscuro, lo de <body> encima.
 */
const effectiveTokens = (
  palette: (typeof PALETTES)[number] | null,
  dark: boolean,
): Record<string, string> => {
  const htmlLevel = {
    ...NORMAL_HTML,
    ...(palette === null
      ? {}
      : tokensOf(
          A11Y,
          (selector) =>
            selector.includes(`[data-pd-palette='${palette}']`) && !selector.includes('body--dark'),
        )),
  };

  if (!dark) return htmlLevel;

  return {
    ...htmlLevel,
    ...NORMAL_BODY_DARK,
    ...(palette === null
      ? {}
      : tokensOf(A11Y, (selector) =>
          selector.includes(`[data-pd-palette='${palette}'] body.body--dark`),
        )),
  };
};

/** Pares fondo/texto de cada badge de ESTADO, leidos de app.scss. */
const STATE_BADGES = [
  'pd-badge--active',
  'pd-badge--running',
  'pd-badge--paused',
  'pd-badge--failed',
  'pd-badge--negative',
  'pd-badge--info',
  'pd-badge--inactive',
] as const;

const tokenName = (value: string | undefined): string =>
  /var\((--[\w-]+)\)/.exec(value ?? '')?.[1] ?? '';

const badgePair = (badge: string): readonly [string, string] => {
  const block = APP.find((candidate) => candidate.selector === `.${badge}`);

  return [tokenName(block?.declarations.background), tokenName(block?.declarations.color)];
};

describe('color-contrast', () => {
  describe('1. Calculo WCAG', () => {
    it('1.1 deberia dar 21:1 entre blanco y negro y 1:1 entre iguales', () => {
      // 1. Arrange + 2. Act + 3. Assert
      expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1);
      expect(contrastRatio('#2c4fc7', '#2c4fc7')).toBe(1);
      expect(relativeLuminance('#fff')).toBe(1);
    });

    it('1.2 deberia rechazar colores que no son hex opacos', () => {
      // 1. Arrange + 2. Act + 3. Assert
      expect(() => contrastRatio('rgba(0,0,0,.4)', '#fff')).toThrow('Color no soportado');
    });
  });

  describe('2. Badges de estado >= 4.5:1 en todas las paletas y modos', () => {
    const cases = [null, ...PALETTES].flatMap((palette) =>
      [false, true].flatMap((dark) =>
        STATE_BADGES.map(
          (badge) => [palette ?? 'normal', dark ? 'oscuro' : 'claro', badge] as const,
        ),
      ),
    );

    it.each(cases)('2.1 paleta %s, modo %s: %s', (paletteName, mode, badge) => {
      // 1. Arrange
      const palette = paletteName === 'normal' ? null : paletteName;
      const tokens = effectiveTokens(palette, mode === 'oscuro');
      const [backgroundToken, textToken] = badgePair(badge);

      // 2. Act
      const ratio = contrastRatio(tokens[backgroundToken] ?? '', tokens[textToken] ?? '');

      // 3. Assert
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });
  });

  describe('3. Foco de teclado >= 3:1 contra el fondo de pagina', () => {
    it.each([null, ...PALETTES].flatMap((palette) => [false, true].map((dark) => [palette, dark])))(
      '3.1 paleta %s, oscuro %s',
      (palette, dark) => {
        // 1. Arrange
        const tokens = effectiveTokens(
          palette as (typeof PALETTES)[number] | null,
          dark as boolean,
        );

        // 2. Act
        const ratio = contrastRatio(tokens['--pd-focus-ring'] ?? '', tokens['--pd-page-bg'] ?? '');

        // 3. Assert (WCAG 1.4.11, componentes no textuales)
        expect(ratio).toBeGreaterThanOrEqual(3);
      },
    );
  });
});
