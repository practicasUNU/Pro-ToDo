import { describe, expect, it } from 'vitest';

import { AuditActionValue } from '@/types/audit';

import {
  AUDIT_ACTION_BADGES,
  changedKeys,
  formatSnapshot,
  labelAuditAction,
  toSelectOptions,
} from './audit-display';

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
    expect(labelAuditAction('CAMBIO_ROL')).toBe('Cambio de rol');
    expect(labelAuditAction('CIERRE_SESION')).toBe('Cierre de sesión');
    expect(labelAuditAction('DESACTIVAR')).toBe('Desactivación');
    // La reanudacion (CU-09) tiene etiqueta y badge propios: no es activar.
    expect(labelAuditAction('REANUDAR')).toBe('Reanudación');
    expect(AUDIT_ACTION_BADGES[AuditActionValue.RESUME]).toBe('pd-badge--running');
    // "Creación" y "Eliminación", NO "Alta" y "Baja": el vocabulario de la
    // pantalla sigue al del enum de la base (`CREAR` / `ELIMINAR`), y las
    // etiquetas del informe en CSV y PDF dicen exactamente lo mismo.
    expect(labelAuditAction('CREAR')).toBe('Creación');
    expect(labelAuditAction('ELIMINAR')).toBe('Eliminación');
    // La eliminacion se pinta en rojo; desactivar NO, que no es borrar.
    expect(AUDIT_ACTION_BADGES[AuditActionValue.DELETE]).toBe('pd-badge--negative');
    expect(AUDIT_ACTION_BADGES[AuditActionValue.DEACTIVATE]).toBe('pd-badge--inactive');
    expect(labelAuditAction('OTRA')).toBe('OTRA');
    expect(toSelectOptions({ A: 'Uno' })).toEqual([{ label: 'Uno', value: 'A' }]);
  });
});
