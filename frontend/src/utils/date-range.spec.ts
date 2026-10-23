import { describe, expect, it } from 'vitest';

import { defaultDateRange, toDateInputValue, toIsoRange } from './date-range';

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
