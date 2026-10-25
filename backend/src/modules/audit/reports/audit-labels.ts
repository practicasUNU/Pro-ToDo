import { AuditTable } from '@modules/audit/audit-tables';
import { AuditActionType } from '@modules/audit/enums/audit-action.enum';

/** Etiquetas en castellano de las acciones, para los informes. */
export const AUDIT_ACTION_LABELS: Readonly<Record<AuditActionType, string>> = {
  [AuditActionType.CREATE]: 'Creación',
  [AuditActionType.UPDATE]: 'Modificación',
  [AuditActionType.DELETE]: 'Eliminación',
  [AuditActionType.ROLE_CHANGE]: 'Cambio de rol',
  [AuditActionType.LOGIN]: 'Inicio de sesión',
  [AuditActionType.LOGIN_FAILED]: 'Inicio de sesión fallido',
  [AuditActionType.LOGOUT]: 'Cierre de sesión',
  [AuditActionType.ACTIVATE]: 'Activación',
  [AuditActionType.DEACTIVATE]: 'Desactivación',
};

/** Etiquetas en castellano de las tablas auditadas. */
export const AUDIT_TABLE_LABELS: Readonly<Record<AuditTable, string>> = {
  [AuditTable.USERS]: 'Usuarios',
  [AuditTable.WORKFLOWS]: 'Flujos',
  [AuditTable.HTML_TEMPLATES]: 'Plantillas HTML',
  [AuditTable.WORKFLOW_TEMPLATES]: 'Plantillas de flujo',
  [AuditTable.AI_PROMPT_TEMPLATES]: 'Plantillas de prompt IA',
  [AuditTable.ALLOWED_IPS]: 'IPs autorizadas',
  [AuditTable.PRECIOS_MODELOS_IA]: 'Tarifas de IA',
};

/**
 * Claves de auditoria que cambian en TODA modificacion: listarlas como
 * "campos modificados" solo anadiria ruido a cada fila.
 */
const BOOKKEEPING_KEYS: ReadonlySet<string> = new Set([
  'updatedAt',
  'updatedByUserId',
]);

export const labelAuditAction = (action: string): string =>
  AUDIT_ACTION_LABELS[action as AuditActionType] ?? action;

export const labelAuditTable = (table: string): string =>
  AUDIT_TABLE_LABELS[table as AuditTable] ?? table;

/**
 * Claves cuyo valor difiere entre las dos fotografias. En un alta son las del
 * registro nuevo; en una baja fisica, las del anterior. Compara por JSON porque
 * los valores pueden ser objetos (esquemas de pipeline, listas de variables).
 */
export const changedAuditKeys = (
  previous: Record<string, unknown> | null,
  next: Record<string, unknown> | null,
): string[] => {
  const keys = new Set([
    ...Object.keys(previous ?? {}),
    ...Object.keys(next ?? {}),
  ]);

  return [...keys].filter(
    (key) =>
      !BOOKKEEPING_KEYS.has(key) &&
      JSON.stringify(previous?.[key]) !== JSON.stringify(next?.[key]),
  );
};
