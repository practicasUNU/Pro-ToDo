/**
 * Auditoria de acciones humanas (migracion 048).
 *
 * Replicas de `AuditEventResponseDto` / `AuditEventPageResponseDto` y de los
 * filtros de `ListAuditEventsQueryDto` del backend (`modules/audit/dto`).
 */

import type { AuditSortKey, SortQuery } from '@/types/sort';

/**
 * Valores del enum `AuditActionType` del backend.
 *
 * EN CASTELLANO, igual que alli: son los literales del CHECK de
 * `audit_eventos.accion` y viajan por la API tal cual, de modo que cualquier
 * divergencia aqui se traduce en un 400 del validador al filtrar.
 */
export enum AuditActionValue {
  CREATE = 'CREAR',
  UPDATE = 'ACTUALIZAR',
  DELETE = 'ELIMINAR',
  ROLE_CHANGE = 'CAMBIO_ROL',
  LOGIN = 'INICIO_SESION',
  LOGIN_FAILED = 'INICIO_SESION_FALLIDO',
  LOGOUT = 'CIERRE_SESION',
  ACTIVATE = 'ACTIVAR',
  DEACTIVATE = 'DESACTIVAR',
}

/** Valores del enum `AuditTable` del backend: nombres reales de tabla. */
export enum AuditTableValue {
  USERS = 'usuarios',
  WORKFLOWS = 'flujos',
  HTML_TEMPLATES = 'plantillas_html',
  WORKFLOW_TEMPLATES = 'plantillas_flujo',
  AI_PROMPT_TEMPLATES = 'plantillas_prompts_ia',
  ALLOWED_IPS = 'allowed_ips',
  PRECIOS_MODELOS_IA = 'precios_modelos_ia',
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

export interface AuditEventsQuery extends AuditEventsFilter, SortQuery<AuditSortKey> {
  readonly limit?: number;
  readonly offset?: number;
}

export type AuditReportFormat = 'csv' | 'pdf';
