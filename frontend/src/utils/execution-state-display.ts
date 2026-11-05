// Helper puro de presentacion (frontend-architecture.md §2.1): como se pinta
// cada estado de una ejecucion. Centralizado para que el historial del
// dashboard y cualquier vista futura no discrepen en etiqueta ni color.

import { ExecutionState } from '@/types/execution';

export interface ExecutionStateDisplay {
  /** Texto visible. El estado NUNCA se comunica solo por color (WCAG 1.4.1). */
  readonly label: string;
  /** Icono que acompana al texto; refuerza, no sustituye. */
  readonly icon: string;
  /** Modificador de `.pd-badge` (tokens de `app.scss`). */
  readonly badgeClass: string;
  /** Explicacion para el tooltip. */
  readonly description: string;
}

const DISPLAY: Readonly<Record<ExecutionState, ExecutionStateDisplay>> = {
  [ExecutionState.EXITOSO]: {
    label: 'Exitoso',
    icon: 'check_circle',
    badgeClass: 'pd-badge--active',
    description: 'Recorrio el pipeline completo sin errores',
  },
  [ExecutionState.EN_PROCESO]: {
    label: 'En proceso',
    icon: 'autorenew',
    badgeClass: 'pd-badge--running',
    description: 'El motor esta recorriendo el pipeline ahora mismo',
  },
  [ExecutionState.PAUSADO]: {
    label: 'Pausado',
    icon: 'pause_circle',
    badgeClass: 'pd-badge--paused',
    description: 'Detenida tras un fallo; se puede reanudar desde Flujos',
  },
  [ExecutionState.FALLIDO]: {
    label: 'Fallido',
    icon: 'error',
    badgeClass: 'pd-badge--failed',
    description: 'Abandonada tras agotar los reintentos',
  },
  [ExecutionState.DESCARTADO]: {
    label: 'Descartado',
    icon: 'block',
    badgeClass: 'pd-badge--inactive',
    description: 'Un operador renuncio a reanudarla',
  },
  [ExecutionState.OMITIDO]: {
    label: 'Omitido',
    icon: 'skip_next',
    badgeClass: 'pd-badge--inactive',
    description: 'Sin trabajo que hacer: no habia correos nuevos o no casaban con el filtro',
  },
  [ExecutionState.INACTIVO]: {
    label: 'En cola',
    icon: 'schedule',
    badgeClass: 'pd-badge--inactive',
    description: 'Creada; el motor aun no ha tomado el primer paso',
  },
};

export const describeExecutionState = (state: ExecutionState): ExecutionStateDisplay =>
  DISPLAY[state];
