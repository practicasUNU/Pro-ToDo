/**
 * Auditoria de acciones humanas (migracion 048).
 *
 * Replicas de `AuditEventResponseDto` / `AuditEventPageResponseDto` y de los
 * filtros de `ListAuditEventsQueryDto` del backend (`modules/audit/dto`).
 */

/** Valores del enum `AuditActionType` del backend. */
export enum AuditActionValue {
  CREATE = 'CREATE',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  ROLE_CHANGE = 'ROLE_CHANGE',
  LOGIN = 'LOGIN',
  LOGIN_FAILED = 'LOGIN_FAILED',
}

/** Valores del enum `AuditTable` del backend: nombres reales de tabla. */
export enum AuditTableValue {
  USERS = 'usuarios',
  WORKFLOWS = 'flujos',
  HTML_TEMPLATES = 'plantillas_html',
  WORKFLOW_TEMPLATES = 'plantillas_flujo',
  AI_PROMPT_TEMPLATES = 'plantillas_prompts_ia',
  ALLOWED_IPS = 'allowed_ips',
}

/** Fotografia plana de un registro (sin secretos ni relaciones). */
export type AuditSnapshot = Readonly<Record<string, unknown>>;

export interface AuditEvent {
  readonly id: string;
  /** ISO 8601 en UTC. */
  readonly createdAt: string;
  readonly userId: string | null;
  readonly userEmail: string | null;
  readonly action: AuditActionValue;
  readonly affectedTable: string;
  readonly recordId: string | null;
  readonly previousData: AuditSnapshot | null;
  readonly newData: AuditSnapshot | null;
  readonly sourceIp: string | null;
}

export interface AuditEventPage {
  readonly items: AuditEvent[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** Filtros comunes a la consulta y a la exportacion. */
export interface AuditEventsFilter {
  readonly userId?: string;
  readonly affectedTable?: AuditTableValue;
  readonly action?: AuditActionValue;
  readonly from?: string;
  readonly to?: string;
}

export interface AuditEventsQuery extends AuditEventsFilter {
  readonly limit?: number;
  readonly offset?: number;
}

export type AuditReportFormat = 'csv' | 'pdf';
