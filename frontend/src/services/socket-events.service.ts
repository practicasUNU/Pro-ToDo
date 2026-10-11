import { EXECUTION_EVENT } from '@/types/execution';
import { getSocket } from '@services/socket.client';

import type {
  ExecutionEventHandlers,
  FlowPausedEvent,
  FlowResumedEvent,
  NodeErrorEvent,
  RoomAck,
} from '@/types/execution';

/**
 * Suscripcion tipada al canal de ejecuciones.
 *
 * Unica capa que conoce los nombres de evento del gateway, igual que un
 * servicio de dominio es el unico que conoce las rutas HTTP
 * (`frontend-architecture.md` §1).
 */

/**
 * Engancha los manejadores y devuelve UNA sola funcion de limpieza.
 *
 * Retira cada listener por su REFERENCIA (`off(evento, manejador)`) y no con
 * `off(evento)` a secas: lo segundo tumbaria tambien los listeners que otro
 * consumidor tenga puestos sobre el mismo evento, y el sintoma seria una vista
 * que deja de actualizarse al desmontarse una vista distinta.
 */
export const subscribeToExecutionEvents = (
  handlers: ExecutionEventHandlers,
): (() => void) => {
  const socket = getSocket();

  const onFlowPaused = (event: FlowPausedEvent): void =>
    handlers.onFlowPaused?.(event);
  const onFlowResumed = (event: FlowResumedEvent): void =>
    handlers.onFlowResumed?.(event);
  const onNodeError = (event: NodeErrorEvent): void =>
    handlers.onNodeError?.(event);

  socket.on(EXECUTION_EVENT.FLOW_PAUSED, onFlowPaused);
  socket.on(EXECUTION_EVENT.FLOW_RESUMED, onFlowResumed);
  socket.on(EXECUTION_EVENT.NODE_ERROR, onNodeError);

  return () => {
    socket.off(EXECUTION_EVENT.FLOW_PAUSED, onFlowPaused);
    socket.off(EXECUTION_EVENT.FLOW_RESUMED, onFlowResumed);
    socket.off(EXECUTION_EVENT.NODE_ERROR, onNodeError);
  };
};

/**
 * Entra en la sala de un flujo para recibir sus eventos.
 *
 * El acuse del servidor se propaga porque el rechazo es silencioso de otro
 * modo: un UUID mal formado o el techo de salas por socket devuelven
 * `{ ok: false }` y la vista simplemente no recibiria nada, sin saber que no
 * llego a suscribirse.
 */
export const joinFlowRoom = async (flowId: string): Promise<RoomAck> =>
  new Promise<RoomAck>((resolve) => {
    getSocket().emit('flow:subscribe', { flowId }, resolve);
  });

export const leaveFlowRoom = async (flowId: string): Promise<RoomAck> =>
  new Promise<RoomAck>((resolve) => {
    getSocket().emit('flow:unsubscribe', { flowId }, resolve);
  });
