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
  [AuditActionType.RESUME]: 'Reanudación',
  [AuditActionType.FLOW_DISCARDED]: 'Flujo descartado',
  [AuditActionType.NODE_SANDBOX_RUN]: 'Prueba de nodo',
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
  [AuditTable.CREDENTIALS]: 'Credenciales',
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

/**
 * Tablas LOGICAS: eventos sin maestra detras y, por tanto, fuera de
 * `AuditTable` (que exige una entidad que fotografiar).
 */
export const LOGICAL_AUDIT_TABLE_LABELS: Readonly<Record<string, string>> = {
  banco_pruebas: 'Banco de pruebas',
};

export const labelAuditTable = (table: string): string =>
  AUDIT_TABLE_LABELS[table as AuditTable] ??
  LOGICAL_AUDIT_TABLE_LABELS[table] ??
  table;

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

/**
 * Aplana una fotografia a `ruta -> valor hoja` (`pipelineSchema.nodes[2].params.customPrompt`).
 *
 * Los objetos y arreglos vacios se conservan como hoja (`{}` / `[]`): si no,
 * pasar de `{ a: 1 }` a `{}` no dejaria ninguna ruta que comparar y el cambio
 * desapareceria del informe.
 */
export const flattenAuditSnapshot = (
  value: unknown,
  prefix = '',
  target: Record<string, unknown> = {},
): Record<string, unknown> => {
  if (Array.isArray(value)) {
    if (value.length === 0 && prefix !== '') {
      target[prefix] = [];
    }

    value.forEach((item, index) =>
      flattenAuditSnapshot(item, `${prefix}[${index}]`, target),
    );

    return target;
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);

    if (entries.length === 0 && prefix !== '') {
      target[prefix] = {};
    }

    for (const [key, child] of entries) {
      flattenAuditSnapshot(
        child,
        prefix === '' ? key : `${prefix}.${key}`,
        target,
      );
    }

    return target;
  }

  if (prefix !== '') {
    target[prefix] = value;
  }

  return target;
};

/**
 * Rutas HOJA cuyo valor difiere entre las dos fotografias. A diferencia de
 * `changedAuditKeys` —que el interceptor necesita a nivel de columna para
 * reconocer un cambio de estado o de rol—, baja hasta el campo concreto: un
 * `customPrompt` editado se lee como `pipelineSchema.nodes[1].params.customPrompt`
 * y no como un `pipelineSchema` entero.
 */
export const changedAuditPaths = (
  previous: Record<string, unknown> | null,
  next: Record<string, unknown> | null,
): string[] => {
  const before = flattenAuditSnapshot(previous ?? {});
  const after = flattenAuditSnapshot(next ?? {});
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);

  return [...paths].filter(
    (path) =>
      !BOOKKEEPING_KEYS.has(path.split(/[.[]/, 1)[0] ?? path) &&
      JSON.stringify(before[path]) !== JSON.stringify(after[path]),
  );
};
