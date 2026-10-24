import { describe, expect, it, vi } from 'vitest';

import { blockNonNumericKeys } from './numeric-input';

/**
 * Evento doble y su espia POR SEPARADO.
 *
 * El espia se devuelve aparte en vez de leerlo luego del objeto: el linter
 * prohibe desligar un metodo de su receptor (`unbound-method`), y aqui ademas
 * se lee mejor que hacer el aserto contra `event.preventDefault`.
 */
const buildEvent = (
  overrides: Partial<KeyboardEvent> = {},
): { event: KeyboardEvent; preventDefault: ReturnType<typeof vi.fn> } => {
  const preventDefault = vi.fn();

  return {
    event: {
      key: '1',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      preventDefault,
      ...overrides,
    } as unknown as KeyboardEvent,
    preventDefault,
  };
};

describe('blockNonNumericKeys', () => {
  it.each(['e', 'E', '+', '-', ',', '.'])('1.1 deberia bloquear "%s"', (key) => {
    // 1. Arrange 📐: `1e5` entra como valor VALIDO en un `type="number"`, el
    //    navegador lo da por bueno y `:max` no lo ataja, porque el campo nunca
    //    llega a estar en estado invalido.
    const { event, preventDefault } = buildEvent({ key });

    // 2. Act ⚙️
    blockNonNumericKeys(event);

    // 3. Assert 🎯
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it.each(['0', '7', 'Backspace', 'Tab', 'ArrowUp', 'Enter', 'Delete'])(
    '1.2 deberia dejar pasar "%s"',
    (key) => {
      // 1. Arrange 📐: las teclas de control se reconocen por la longitud de
      //    `key`; enumerarlas seria una lista larga, incompleta y distinta en
      //    cada navegador.
      const { event, preventDefault } = buildEvent({ key });

      // 2. Act ⚙️
      blockNonNumericKeys(event);

      // 3. Assert 🎯
      expect(preventDefault).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Meta', { metaKey: true }],
  ])('1.3 NO deberia romper los atajos con %s', (_label, modifier) => {
    // 1. Arrange 📐: sin esto, «pegar» (Ctrl+V) y «deshacer» (Ctrl+Z) dejarian
    //    de funcionar en cuanto la letra coincidiera con una bloqueada.
    const { event, preventDefault } = buildEvent({ key: 'e', ...modifier });

    // 2. Act ⚙️
    blockNonNumericKeys(event);

    // 3. Assert 🎯
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
