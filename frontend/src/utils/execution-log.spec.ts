import { describe, expect, it } from 'vitest';

import { canInspectLog } from './execution-log';

import { ExecutionState } from '@/types/execution';

describe('canInspectLog', () => {
  it('deberia ofrecer el log en ejecuciones FALLIDO y PAUSADO', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(canInspectLog({ state: ExecutionState.FALLIDO, hasAlerts: false })).toBe(true);
    expect(canInspectLog({ state: ExecutionState.PAUSADO, hasAlerts: false })).toBe(true);
  });

  it('deberia ofrecerlo en cualquier estado si hubo alertas', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯: una ejecucion reanudada que
    //    termino bien conserva sus alertas para auditoria.
    expect(canInspectLog({ state: ExecutionState.EXITOSO, hasAlerts: true })).toBe(true);
  });

  it('NO deberia ofrecerlo en ejecuciones normales sin observaciones', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    for (const state of [
      ExecutionState.EXITOSO,
      ExecutionState.EN_PROCESO,
      ExecutionState.INACTIVO,
      ExecutionState.OMITIDO,
      ExecutionState.DESCARTADO,
    ]) {
      expect(canInspectLog({ state, hasAlerts: false })).toBe(false);
    }
  });
});
