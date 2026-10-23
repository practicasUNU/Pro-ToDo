import { describe, expect, it } from 'vitest';

import { EMPTY_VALUE, formatInteger, formatPercent, formatUsd } from './number-format';

describe('number-format', () => {
  it('formatInteger deberia separar miles al estilo es-ES', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(formatInteger(1_234_567)).toBe('1.234.567');
  });

  it('formatUsd deberia conservar fracciones de centimo', () => {
    // 1. Arrange 📐: una inferencia de Gemini cuesta fracciones de centimo.
    // 2. Act ⚙️
    const formatted = formatUsd(0.000255);

    // 3. Assert 🎯
    expect(formatted).toContain('0,000255');
    expect(formatted).toContain('US$');
  });

  it('formatPercent deberia distinguir "sin datos" de 0 %', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(formatPercent(null)).toBe(EMPTY_VALUE);
    expect(formatPercent(0.75)).toMatch(/75\s%/);
  });
});
