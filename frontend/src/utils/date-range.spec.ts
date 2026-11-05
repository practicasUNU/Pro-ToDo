import { describe, expect, it } from 'vitest';

import { datePickerBounds, defaultDateRange, isFutureDate, toDateInputValue, toIsoRange } from './date-range';

describe('date-range', () => {
  it('defaultDateRange deberia cubrir los ultimos 30 dias con hoy incluido', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const range = defaultDateRange(new Date(2026, 9, 22, 15, 30));

    // 3. Assert 🎯
    expect(range).toEqual({ from: '2026-09-23', to: '2026-10-22' });
  });

  it('toIsoRange deberia usar medianoches locales y un fin exclusivo', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const range = toIsoRange({ from: '2026-10-01', to: '2026-10-22' });

    // 3. Assert 🎯: "hasta el 22" incluye el 22 entero.
    expect(range).toEqual({
      from: new Date(2026, 9, 1).toISOString(),
      to: new Date(2026, 9, 23).toISOString(),
    });
  });

  it('toIsoRange deberia aceptar un unico dia', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(toIsoRange({ from: '2026-10-22', to: '2026-10-22' })).not.toBeNull();
  });

  it('toIsoRange deberia rechazar rangos invertidos y fechas invalidas', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(toIsoRange({ from: '2026-10-23', to: '2026-10-22' })).toBeNull();
    expect(toIsoRange({ from: '', to: '2026-10-22' })).toBeNull();
    expect(toIsoRange({ from: '22/10/2026', to: '2026-10-22' })).toBeNull();
  });

  it('toDateInputValue deberia formatear en el huso local sin pasar por UTC', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(toDateInputValue(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('datePickerBounds e isFutureDate', () => {
  const NOW = new Date(2026, 9, 23);

  it('4.1 deberia topar el calendario en HOY', () => {
    // 1. Arrange 📐: ni la telemetria ni la auditoria tienen filas del futuro,
    //    de modo que un rango que empiece manana devuelve siempre vacio, y el
    //    usuario lo leeria como "no hay datos" en vez de como "has pedido algo
    //    imposible".
    // 2. Act ⚙️
    const { max } = datePickerBounds(NOW);

    // 3. Assert 🎯: `q-date` usa barras, no guiones.
    expect(max).toBe('2026/10/23');
  });

  it('4.2 deberia topar hacia atras en el limite del historial', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const { min } = datePickerBounds(NOW);

    // 3. Assert 🎯: un ano antes.
    expect(min).toBe('2025/10/23');
  });

  it('4.3 deberia reconocer una fecha futura', () => {
    // 1. Arrange 📐: `q-date` bloquea el clic, pero el campo se teclea y se
    //    pega, asi que la regla de validacion necesita la misma pregunta.
    // 2. Act ⚙️ & 3. Assert 🎯
    expect(isFutureDate('2026-10-24', NOW)).toBe(true);
    expect(isFutureDate('2026-10-23', NOW)).toBe(false);
    expect(isFutureDate('2026-10-22', NOW)).toBe(false);
  });

  it('4.4 NO deberia tratar como futura una cadena que no es fecha', () => {
    // 1. Arrange 📐: de eso ya se queja `toIsoRange`, y dar dos errores por el
    //    mismo valor confunde.
    // 2. Act ⚙️ & 3. Assert 🎯
    expect(isFutureDate('', NOW)).toBe(false);
    expect(isFutureDate('no-es-fecha', NOW)).toBe(false);
  });
});
