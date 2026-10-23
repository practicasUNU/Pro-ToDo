import { BadRequestException } from '@nestjs/common';

import { resolveTelemetryRange } from '@modules/telemetry/utils/telemetry-range.util';

const NOW = new Date('2026-10-22T12:00:00.000Z');

describe('resolveTelemetryRange', () => {
  it('deberia cubrir los 30 dias previos a ahora sin filtros', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const range = resolveTelemetryRange({}, NOW);

    // 3. Assert 🎯
    expect(range.to).toEqual(NOW);
    expect(range.from).toEqual(new Date('2026-09-22T12:00:00.000Z'));
  });

  it('deberia incluir el dia completo cuando to es una fecha sin hora', () => {
    // 1. Arrange 📐: quien elige "hasta el 22" espera ver las 23:59 del 22.
    // 2. Act ⚙️
    const range = resolveTelemetryRange(
      { from: '2026-10-01', to: '2026-10-22' },
      NOW,
    );

    // 3. Assert 🎯: fin exclusivo, el 23 a las 00:00.
    expect(range.from).toEqual(new Date('2026-10-01T00:00:00.000Z'));
    expect(range.to).toEqual(new Date('2026-10-23T00:00:00.000Z'));
  });

  it('deberia respetar un instante ISO completo en to', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const range = resolveTelemetryRange(
      { to: '2026-10-22T00:00:00+02:00' },
      NOW,
    );

    // 3. Assert 🎯
    expect(range.to).toEqual(new Date('2026-10-21T22:00:00.000Z'));
  });

  it('deberia rechazar un rango vacio o invertido con 400', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(() =>
      resolveTelemetryRange(
        { from: '2026-10-22T00:00:00Z', to: '2026-10-01T00:00:00Z' },
        NOW,
      ),
    ).toThrow(BadRequestException);
  });
});
