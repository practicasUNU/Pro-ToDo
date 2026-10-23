import type { AuditableData } from '@/types/auditable';

/**
 * Auditoria neutra para los literales de prueba de filas maestras.
 *
 * Solo la importan los `*.spec.ts`: existe para que cada fixture de usuario,
 * plantilla, flujo o prompt no repita los cuatro campos que la migracion 045
 * anadio a todas esas filas. Sin autores, que es como llegan las filas
 * anteriores a la auditoria.
 */
export const AUDIT_FIXTURE: AuditableData = {
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  createdBy: null,
  updatedBy: null,
};
