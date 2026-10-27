// Helpers puros de presentacion de la auditoria (frontend-architecture.md
// §2.1): etiquetas en castellano y comparacion de fotografias, sin estado ni I/O.

import { AuditActionValue, AuditTableValue } from '@/types/audit';

import type { AuditSnapshot } from '@/types/audit';

export const AUDIT_ACTION_LABELS: Readonly<Record<AuditActionValue, string>> = {
  [AuditActionValue.CREATE]: 'Creación',
  [AuditActionValue.UPDATE]: 'Modificación',
  [AuditActionValue.DELETE]: 'Eliminación',
  [AuditActionValue.ROLE_CHANGE]: 'Cambio de rol',
  [AuditActionValue.LOGIN]: 'Inicio de sesión',
  [AuditActionValue.LOGIN_FAILED]: 'Inicio de sesión fallido',
  [AuditActionValue.LOGOUT]: 'Cierre de sesión',
  [AuditActionValue.ACTIVATE]: 'Activación',
  [AuditActionValue.DEACTIVATE]: 'Desactivación',
  [AuditActionValue.RESUME]: 'Reanudación',
  [AuditActionValue.FLOW_DISCARDED]: 'Flujo descartado',
};

export const AUDIT_TABLE_LABELS: Readonly<Record<AuditTableValue, string>> = {
  [AuditTableValue.USERS]: 'Usuarios',
  [AuditTableValue.WORKFLOWS]: 'Flujos',
  [AuditTableValue.HTML_TEMPLATES]: 'Plantillas HTML',
  [AuditTableValue.WORKFLOW_TEMPLATES]: 'Plantillas de flujo',
  [AuditTableValue.AI_PROMPT_TEMPLATES]: 'Plantillas de prompt IA',
  [AuditTableValue.ALLOWED_IPS]: 'IPs autorizadas',
  [AuditTableValue.PRECIOS_MODELOS_IA]: 'Tarifas de IA',
  [AuditTableValue.CREDENTIALS]: 'Credenciales',
};

/**
 * Clase de badge por accion, reutilizando las de `app.scss`. El color va
 * acompanado SIEMPRE del texto de la accion (WCAG: nunca solo color).
 */
export const AUDIT_ACTION_BADGES: Readonly<Record<AuditActionValue, string>> = {
  [AuditActionValue.CREATE]: 'pd-badge--active',
  [AuditActionValue.UPDATE]: 'pd-badge--role',
  // Rojo y no el gris de "inactivo": una eliminacion es irreversible y es lo
  // que un auditor busca primero. `DEACTIVATE` SI se queda en gris, porque
  // desactivar no es borrar y pintarlas igual las volveria indistinguibles.
  [AuditActionValue.DELETE]: 'pd-badge--negative',
  [AuditActionValue.ROLE_CHANGE]: 'pd-badge--paused',
  [AuditActionValue.LOGIN]: 'pd-badge--running',
  [AuditActionValue.LOGIN_FAILED]: 'pd-badge--failed',
  // El cierre de sesion es el contrapunto neutro del inicio: ni exito ni
  // fallo, solo el final de una sesion.
  [AuditActionValue.LOGOUT]: 'pd-badge--paused',
  [AuditActionValue.ACTIVATE]: 'pd-badge--active',
  [AuditActionValue.DEACTIVATE]: 'pd-badge--inactive',
  // Mismo azul que una ejecucion en curso: reanudar es devolver el flujo a la
  // marcha, no armarlo de cero (eso es `ACTIVATE`).
  [AuditActionValue.RESUME]: 'pd-badge--running',
  // Rojo de fallo: el trabajo pendiente se abandona y no se puede reanudar.
  [AuditActionValue.FLOW_DISCARDED]: 'pd-badge--failed',
};

/** Opciones cerradas de un `q-select` (Poka-Yoke): `{ label, value }`. */
export const toSelectOptions = <T extends string>(
  labels: Readonly<Record<T, string>>,
): Array<{ label: string; value: T }> =>
  (Object.entries(labels) as Array<[T, string]>).map(([value, label]) => ({ label, value }));

export const labelAuditAction = (action: string): string =>
  AUDIT_ACTION_LABELS[action as AuditActionValue] ?? action;

export const labelAuditTable = (table: string): string =>
  AUDIT_TABLE_LABELS[table as AuditTableValue] ?? table;

/**
 * Claves de auditoria que cambian en TODA modificacion: listarlas como "campos
 * modificados" solo anadiria ruido. Mismo criterio que el informe del backend.
 */
const BOOKKEEPING_KEYS: ReadonlySet<string> = new Set(['updatedAt', 'updatedByUserId']);

/**
 * Claves cuyo valor difiere entre las dos fotografias. En un alta son las del
 * registro nuevo; en una baja fisica, las del anterior.
 */
export const changedKeys = (
  previous: AuditSnapshot | null,
  next: AuditSnapshot | null,
): string[] => {
  const keys = new Set([...Object.keys(previous ?? {}), ...Object.keys(next ?? {})]);

  return [...keys].filter(
    (key) =>
      !BOOKKEEPING_KEYS.has(key) && JSON.stringify(previous?.[key]) !== JSON.stringify(next?.[key]),
  );
};

/** JSON legible de una fotografia, o un guion si no la hay. */
export const formatSnapshot = (snapshot: AuditSnapshot | null): string =>
  snapshot === null ? '—' : JSON.stringify(snapshot, null, 2);
