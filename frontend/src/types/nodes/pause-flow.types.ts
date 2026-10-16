// Replica del contrato de `PauseFlowConfigDto` (backend). Cualquier cambio alla
// debe reflejarse aqui.

/**
 * Momento en que el nodo congela el flujo.
 *
 * NO es una politica de reanudacion: de PAUSADO solo se sale por CU-09, con un
 * operador delante. Lo que elige este enum es CUANDO entra la pausa una vez que
 * el paso anterior ha concluido.
 */
export enum PauseTriggerMode {
  IMMEDIATE = 'IMMEDIATE',
  DELAYED = 'DELAYED',
}

/**
 * Tope del retardo, replicado de `MAX_PAUSE_DELAY_SECONDS`.
 *
 * Quince minutos. La espera transcurre con la ejecucion viva ocupando una plaza
 * de la capacidad global del motor, asi que el limite no es cosmetico: se
 * replica aqui para que el formulario lo impida antes de que el backend tenga
 * que rechazar el flujo entero.
 */
export const MAX_PAUSE_DELAY_SECONDS = 900;

/** Longitud maxima del mensaje, replicada de `MAX_PAUSE_MESSAGE_LENGTH`. */
export const MAX_PAUSE_MESSAGE_LENGTH = 500;

/** Retardo que se propone al cambiar a "con retardo". Cinco minutos. */
export const DEFAULT_PAUSE_DELAY_SECONDS = 300;

/**
 * Configuracion del nodo `PAUSA_FLOW` en el cliente.
 *
 * NINGUN campo es opcional aqui, aunque el DTO del backend los admita todos
 * ausentes: un `undefined` enlazado a un `q-input` lo convierte en campo
 * descontrolado en Vue. La ausencia se representa con `''` o `0`, y es
 * `toNodeParams()` quien decide que se publica y que se omite.
 */
export interface PauseFlowNodeConfig {
  pauseMode: PauseTriggerMode;
  /** Segundos de espera. Solo se publica con el modo diferido. */
  delaySeconds: number;
  notifyOnPause: boolean;
  notificationRecipient: string;
  customPauseMessage: string;
}
