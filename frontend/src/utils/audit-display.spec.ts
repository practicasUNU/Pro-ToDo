import { describe, expect, it } from 'vitest';

import { changedKeys, formatSnapshot, labelAuditAction, toSelectOptions } from './audit-display';

describe('audit-display', () => {
  it('1.1 changedKeys deberia listar solo lo que cambio, sin la contabilidad de auditoria', () => {
    // 1. Arrange 📐
    const previous = { role: 'EDITOR', email: 'e@unuware.com', updatedAt: 'a' };
    const next = { role: 'ADMIN', email: 'e@unuware.com', updatedAt: 'b' };

    // 2. Act ⚙️
    const keys = changedKeys(previous, next);

    // 3. Assert 🎯
    expect(keys).toEqual(['role']);
  });

  it('1.2 changedKeys deberia comparar objetos por contenido', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(changedKeys({ schema: { a: 1 } }, { schema: { a: 1 } })).toEqual([]);
    expect(changedKeys(null, { name: 'Alta' })).toEqual(['name']);
  });

  it('1.3 formatSnapshot deberia indentar el JSON o devolver un guion', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(formatSnapshot({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatSnapshot(null)).toBe('—');
  });

  it('1.4 deberia etiquetar en castellano y caer al valor crudo si no lo conoce', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(labelAuditAction('ROLE_CHANGE')).toBe('Cambio de rol');
    expect(labelAuditAction('OTRA')).toBe('OTRA');
    expect(toSelectOptions({ A: 'Uno' })).toEqual([{ label: 'Uno', value: 'A' }]);
  });
});
