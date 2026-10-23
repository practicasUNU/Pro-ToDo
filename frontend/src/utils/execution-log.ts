// Helper puro de presentacion (frontend-architecture.md §2.1): cuando ofrecer
// el visor de logs de una ejecucion.

import { ExecutionState } from '@/types/execution';

import type { ExecutionSummary } from '@/types/execution';

/** Estados que siempre merecen inspeccion: algo se detuvo o se rindio. */
const INSPECTABLE_STATES: ReadonlySet<ExecutionState> = new Set([
  ExecutionState.PAUSADO,
  ExecutionState.FALLIDO,
]);

/**
 * `true` si la fila tiene algo que inspeccionar: un fallo, una pausa o alguna
 * alerta registrada. Una ejecucion en curso o exitosa sin observaciones no
 * ofrece el visor: el boton en cada fila lo convertiria en ruido.
 */
export const canInspectLog = (execution: Pick<ExecutionSummary, 'state' | 'hasAlerts'>): boolean =>
  INSPECTABLE_STATES.has(execution.state) || execution.hasAlerts;
