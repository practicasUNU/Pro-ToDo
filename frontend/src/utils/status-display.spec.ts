import { describe, expect, it } from 'vitest';

import {
  describeEnabled,
  describeSeverity,
  describeWorkflowStatus,
  isNodeErrorSeverity,
} from './status-display';

import { WorkflowStatus } from '@/types/pipeline';

import type { NodeErrorSeverity } from '@/types/execution';

describe('status-display (WCAG 1.4.1: nunca solo color)', () => {
  it.each(Object.values(WorkflowStatus))(
    '1.1 el estado %s lleva texto, icono y clase',
    (status) => {
      // 1. Arrange + 2. Act
      const display = describeWorkflowStatus(status);

      // 3. Assert
      expect(display.label).not.toBe('');
      expect(display.icon).not.toBe('');
      expect(display.badgeClass).toMatch(/^pd-badge--/);
    },
  );

  it.each(['LEVE', 'GRAVE', 'URGENTE'] as NodeErrorSeverity[])(
    '1.2 la severidad %s lleva texto, icono y clase distintos',
    (level) => {
      // 1. Arrange + 2. Act
      const display = describeSeverity(level);

      // 3. Assert
      expect(display.label).not.toBe('');
      expect(display.icon).not.toBe('');
      expect(display.badgeClass).toMatch(/^pd-badge--/);
    },
  );

  it('1.3 las tres severidades se distinguen tambien por icono', () => {
    // 1. Arrange + 2. Act
    const icons = (['LEVE', 'GRAVE', 'URGENTE'] as const).map(
      (level) => describeSeverity(level).icon,
    );

    // 3. Assert
    expect(new Set(icons).size).toBe(3);
  });

  it('1.4 deberia respetar las etiquetas propias de cada tabla', () => {
    // 1. Arrange + 2. Act
    const display = describeEnabled(false, { on: 'Vigente', off: 'Histórico' });

    // 3. Assert
    expect(display.label).toBe('Histórico');
    expect(display.badgeClass).toBe('pd-badge--inactive');
  });

  it('1.5 deberia reconocer solo severidades conocidas', () => {
    // 1. Arrange + 2. Act + 3. Assert
    expect(isNodeErrorSeverity('GRAVE')).toBe(true);
    expect(isNodeErrorSeverity('ADVERTENCIA')).toBe(false);
  });
});
