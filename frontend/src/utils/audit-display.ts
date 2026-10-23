// Helpers puros de presentacion de la auditoria (frontend-architecture.md
// §2.1): etiquetas en castellano y comparacion de fotografias, sin estado ni I/O.

import { AuditActionValue, AuditTableValue } from '@/types/audit';

import type { AuditSnapshot } from '@/types/audit';

export const AUDIT_ACTION_LABELS: Readonly<Record<AuditActionValue, string>> = {
  [AuditActionValue.CREATE]: 'Alta',
  [AuditActionValue.UPDATE]: 'Modificación',
  [AuditActionValue.DELETE]: 'Baja',
  [AuditActionValue.ROLE_CHANGE]: 'Cambio de rol',
  [AuditActionValue.LOGIN]: 'Inicio de sesión',
  [AuditActionValue.LOGIN_FAILED]: 'Inicio de sesión fallido',
};

export const AUDIT_TABLE_LABELS: Readonly<Record<AuditTableValue, string>> = {
  [AuditTableValue.USERS]: 'Usuarios',
  [AuditTableValue.WORKFLOWS]: 'Flujos',
  [AuditTableValue.HTML_TEMPLATES]: 'Plantillas HTML',
  [AuditTableValue.WORKFLOW_TEMPLATES]: 'Plantillas de flujo',
  [AuditTableValue.AI_PROMPT_TEMPLATES]: 'Plantillas de prompt IA',
  [AuditTableValue.ALLOWED_IPS]: 'IPs autorizadas',
};

/**
 * Clase de badge por accion, reutilizando las de `app.scss`. El color va
 * acompanado SIEMPRE del texto de la accion (WCAG: nunca solo color).
 */
export const AUDIT_ACTION_BADGES: Readonly<Record<AuditActionValue, string>> = {
  [AuditActionValue.CREATE]: 'pd-badge--active',
  [AuditActionValue.UPDATE]: 'pd-badge--role',
  [AuditActionValue.DELETE]: 'pd-badge--inactive',
  [AuditActionValue.ROLE_CHANGE]: 'pd-badge--paused',
  [AuditActionValue.LOGIN]: 'pd-badge--running',
  [AuditActionValue.LOGIN_FAILED]: 'pd-badge--failed',
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
