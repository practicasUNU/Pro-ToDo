// Helper puro de presentacion (frontend-architecture.md §2.1): como se pinta
// el estado de un FLUJO y la severidad de un fallo. Hermano de
// `execution-state-display.ts`, que cubre el de una ejecucion.
//
// WCAG 1.4.1: ningun estado se comunica solo por color. Cada entrada lleva
// texto e icono, y el color es un refuerzo (los pares relleno/texto de cada
// `pd-badge--*` superan 4.5:1, ver `color-contrast.spec.ts`).

import { presentationOf } from '@/utils/alert-categorizer';

import { WorkflowStatus } from '@/types/pipeline';
import { AiCallStatus } from '@/types/telemetry';

import type { NodeErrorSeverity } from '@/types/execution';

/** Lo minimo para pintar un estado: texto, icono y modificador de `.pd-badge`. */
export interface StatusDisplay {
  readonly label: string;
  readonly icon: string;
  readonly badgeClass: string;
}

const WORKFLOW_STATUS_DISPLAY: Readonly<Record<WorkflowStatus, StatusDisplay>> = {
  [WorkflowStatus.ACTIVO]: { label: 'Activo', icon: 'toggle_on', badgeClass: 'pd-badge--active' },
  [WorkflowStatus.PAUSADO]: {
    label: 'Pausado',
    icon: 'pause_circle',
    badgeClass: 'pd-badge--paused',
  },
  [WorkflowStatus.INACTIVO]: {
    label: 'Inactivo',
    icon: 'toggle_off',
    badgeClass: 'pd-badge--inactive',
  },
};

const SEVERITY_BADGE: Readonly<Record<NodeErrorSeverity, string>> = {
  LEVE: 'pd-badge--info',
  GRAVE: 'pd-badge--paused',
  URGENTE: 'pd-badge--failed',
};

const SEVERITY_LABEL: Readonly<Record<NodeErrorSeverity, string>> = {
  LEVE: 'Leve',
  GRAVE: 'Grave',
  URGENTE: 'Urgente',
};

/** Estado de habilitacion de un flujo (ACTIVO, PAUSADO, INACTIVO). */
export const describeWorkflowStatus = (status: WorkflowStatus): StatusDisplay =>
  WORKFLOW_STATUS_DISPLAY[status];

/**
 * Severidad de un fallo de nodo. El icono es el MISMO que el del aviso flotante
 * (`alert-categorizer.ts`), para que el operador reconozca el nivel igual en el
 * toast que en la tabla.
 */
export const describeSeverity = (level: NodeErrorSeverity): StatusDisplay => ({
  label: SEVERITY_LABEL[level],
  icon: presentationOf(level).icon,
  badgeClass: SEVERITY_BADGE[level],
});

/** Es una severidad conocida (los logs traen el nivel como texto libre). */
export const isNodeErrorSeverity = (value: unknown): value is NodeErrorSeverity =>
  value === 'LEVE' || value === 'GRAVE' || value === 'URGENTE';

/**
 * Habilitacion generica de una maestra (plantillas, usuarios, tarifas...):
 * activo o no, con las etiquetas propias de cada tabla.
 */
export const describeEnabled = (
  enabled: boolean,
  labels: { readonly on: string; readonly off: string } = { on: 'Activo', off: 'Inactivo' },
): StatusDisplay =>
  enabled
    ? { label: labels.on, icon: 'check_circle', badgeClass: 'pd-badge--active' }
    : { label: labels.off, icon: 'do_not_disturb_on', badgeClass: 'pd-badge--inactive' };

const AI_CALL_STATUS_DISPLAY: Readonly<Record<AiCallStatus, StatusDisplay>> = {
  [AiCallStatus.SUCCESS]: {
    label: 'Exitosa',
    icon: 'check_circle',
    badgeClass: 'pd-badge--active',
  },
  [AiCallStatus.FAILED]: {
    label: 'Fallida',
    icon: 'error_outline',
    badgeClass: 'pd-badge--failed',
  },
};

/** Resultado de una llamada a un modelo de IA (migracion 060). */
export const describeAiCallStatus = (status: AiCallStatus): StatusDisplay =>
  AI_CALL_STATUS_DISPLAY[status];
