import { describe, expect, it } from 'vitest';

import { describeExecutionState } from './execution-state-display';

import { ExecutionState } from '@/types/execution';

describe('describeExecutionState', () => {
  it('deberia dar etiqueta, icono y clase a los siete estados', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯: un estado sin texto se
    //    comunicaria solo por color (WCAG 1.4.1).
    for (const state of Object.values(ExecutionState)) {
      const display = describeExecutionState(state);

      expect(display.label.length).toBeGreaterThan(0);
      expect(display.icon.length).toBeGreaterThan(0);
      expect(display.badgeClass).toMatch(/^pd-badge--/);
    }
  });

  it('no deberia pintar DESCARTADO ni OMITIDO como fallo', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(describeExecutionState(ExecutionState.DESCARTADO).badgeClass).not.toBe(
      'pd-badge--failed',
    );
    expect(describeExecutionState(ExecutionState.OMITIDO).badgeClass).not.toBe('pd-badge--failed');
    expect(describeExecutionState(ExecutionState.FALLIDO).badgeClass).toBe('pd-badge--failed');
  });
});
