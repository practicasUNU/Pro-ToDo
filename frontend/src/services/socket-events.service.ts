import { CRUD_EVENT } from '@/types/crud-events';
import { SESSION_EVENT } from '@/types/session-events';
import { PRICING_EVENT } from '@/types/pricing-events';
import { EXECUTION_EVENT } from '@/types/execution';
import { getSocket } from '@services/socket.client';

import type { CrudMutationPayload } from '@/types/crud-events';
import type { UserModifiedPayload } from '@/types/session-events';
import type { PricingUpdatedPayload } from '@/types/pricing-events';
import type {
  ExecutionEventHandlers,
  FlowCompletedEvent,
  FlowDiscardedEvent,
  FlowPausedEvent,
  FlowResumedEvent,
  NodeCompletedEvent,
  NodeErrorEvent,
  NodeStartedEvent,
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
export const subscribeToExecutionEvents = (handlers: ExecutionEventHandlers): (() => void) => {
  const socket = getSocket();

  const onFlowPaused = (event: FlowPausedEvent): void => handlers.onFlowPaused?.(event);
  const onFlowResumed = (event: FlowResumedEvent): void => handlers.onFlowResumed?.(event);
  const onFlowDiscarded = (event: FlowDiscardedEvent): void => handlers.onFlowDiscarded?.(event);
  const onFlowCompleted = (event: FlowCompletedEvent): void => handlers.onFlowCompleted?.(event);
  const onNodeError = (event: NodeErrorEvent): void => handlers.onNodeError?.(event);
  const onNodeStarted = (event: NodeStartedEvent): void => handlers.onNodeStarted?.(event);
  const onNodeCompleted = (event: NodeCompletedEvent): void => handlers.onNodeCompleted?.(event);

  socket.on(EXECUTION_EVENT.FLOW_PAUSED, onFlowPaused);
  socket.on(EXECUTION_EVENT.FLOW_RESUMED, onFlowResumed);
  socket.on(EXECUTION_EVENT.FLOW_DISCARDED, onFlowDiscarded);
  socket.on(EXECUTION_EVENT.FLOW_COMPLETED, onFlowCompleted);
  socket.on(EXECUTION_EVENT.NODE_ERROR, onNodeError);
  socket.on(EXECUTION_EVENT.NODE_STARTED, onNodeStarted);
  socket.on(EXECUTION_EVENT.NODE_COMPLETED, onNodeCompleted);

  return () => {
    socket.off(EXECUTION_EVENT.FLOW_PAUSED, onFlowPaused);
    socket.off(EXECUTION_EVENT.FLOW_RESUMED, onFlowResumed);
    socket.off(EXECUTION_EVENT.FLOW_DISCARDED, onFlowDiscarded);
    socket.off(EXECUTION_EVENT.FLOW_COMPLETED, onFlowCompleted);
    socket.off(EXECUTION_EVENT.NODE_ERROR, onNodeError);
    socket.off(EXECUTION_EVENT.NODE_STARTED, onNodeStarted);
    socket.off(EXECUTION_EVENT.NODE_COMPLETED, onNodeCompleted);
  };
};

/**
 * Escucha las mutaciones de tablas maestras.
 *
 * El servidor decide quien recibe cada entidad —las administrativas solo
 * alcanzan la sala de administradores—, de modo que aqui no hay que filtrar
 * por rol: lo que llega es lo que corresponde a esta sesion.
 *
 * La baja se hace POR REFERENCIA, igual que en `subscribeToExecutionEvents`:
 * un `off` a secas sobre el nombre del evento se llevaria por delante a
 * cualquier otro suscriptor del mismo canal.
 */
export const subscribeToCrudMutations = (
  handler: (payload: CrudMutationPayload) => void,
): (() => void) => {
  const socket = getSocket();

  socket.on(CRUD_EVENT.MUTATION, handler);

  return () => {
    socket.off(CRUD_EVENT.MUTATION, handler);
  };
};

/**
 * Escucha los avisos dirigidos a la cuenta propia.
 *
 * El gateway manda `user:modified` SOLO a la sala `user_${userId}`, de modo
 * que un socket nunca recibe el de otra persona. Aun asi quien lo consume
 * vuelve a comprobar el `userId`: el socket sobrevive a un cambio de sesion en
 * la misma pestana, y confiar en la sala para una expulsion seria apoyar una
 * decision de seguridad en una suposicion del transporte.
 *
 * La baja va POR REFERENCIA, igual que las otras suscripciones y por el mismo
 * motivo: un `off` a secas sobre el nombre del evento se llevaria por delante
 * a cualquier otro suscriptor del mismo canal.
 */
export const subscribeToSessionEvents = (
  handler: (payload: UserModifiedPayload) => void,
): (() => void) => {
  const socket = getSocket();

  socket.on(SESSION_EVENT.USER_MODIFIED, handler);

  return () => {
    socket.off(SESSION_EVENT.USER_MODIFIED, handler);
  };
};

/**
 * Escucha los relevos de tarifas de IA.
 *
 * El gateway solo lo manda a la sala de los ADMIN, que son los unicos que
 * pueden abrir la pantalla de precios. La baja va POR REFERENCIA, igual que el
 * resto de suscripciones.
 */
export const subscribeToPricingEvents = (
  handler: (payload: PricingUpdatedPayload) => void,
): (() => void) => {
  const socket = getSocket();

  socket.on(PRICING_EVENT.UPDATED, handler);

  return () => {
    socket.off(PRICING_EVENT.UPDATED, handler);
  };
};

/**
 * Avisa cada vez que el socket queda conectado, reconexiones incluidas.
 *
 * `connect` lo emite el cliente de Socket.io tanto en la conexion inicial como
 * tras cada reintento del reconector automatico, y no hay forma de distinguir
 * una de otra desde aqui. Quien escuche tiene que tolerar que le llamen de mas:
 * la primera vez normalmente no hay nada que reconciliar.
 *
 * Existe para que el consumidor NO tenga que importar `getSocket` ni conocer el
 * nombre del evento: este archivo es la unica capa que habla con Socket.io, y
 * una vista enganchandose al transporte por su cuenta rompe esa frontera.
 *
 * La baja va POR REFERENCIA, igual que las dos suscripciones de arriba y por el
 * mismo motivo: el boot tiene su propio `connect` puesto —es quien vuelve a las
 * salas— y un `off` a secas lo dejaria fuera de combate.
 */
export const subscribeToReconnect = (handler: () => void): (() => void) => {
  const socket = getSocket();

  socket.on('connect', handler);

  return () => {
    socket.off('connect', handler);
  };
};

/**
 * Margen para que el servidor acuse una peticion de sala.
 *
 * Cinco segundos cubren con holgura un acuse real —el gateway solo consulta la
 * fila del flujo— y acotan la espera cuando no hay nadie al otro lado.
 */
const ROOM_ACK_TIMEOUT_MS = 5000;

/** Motivo del acuse que nunca llego. Lo distingue de un rechazo del gateway. */
export const ACK_TIMEOUT = 'ACK_TIMEOUT';

/**
 * Pide una sala y espera el acuse, con tope de tiempo.
 *
 * El tope NO es decorativo. Sin el, la promesa se resolvia UNICAMENTE desde el
 * callback del servidor: con el socket caido, Socket.io encola el `emit` y el
 * `await` quedaba pendiente para siempre, de modo que un fallo de transporte se
 * manifestaba como silencio absoluto en vez de un error accionable.
 *
 * Se usa el `timeout()` nativo en lugar de un `setTimeout` propio porque
 * cancela el acuse por su cuenta; un temporizador manual habria que limpiarlo
 * en las dos ramas y dejaria el callback vivo tras expirar.
 *
 * El vencimiento se traduce al mismo `RoomAck` que ya consume el store, asi que
 * ninguna capa superior distingue un rechazo de un silencio: ambos impiden
 * apuntar la sala.
 */
const requestRoom = async (
  event: 'flow:subscribe' | 'flow:unsubscribe',
  flowId: string,
): Promise<RoomAck> => {
  try {
    return await getSocket().timeout(ROOM_ACK_TIMEOUT_MS).emitWithAck(event, { flowId });
  } catch {
    return { ok: false, reason: ACK_TIMEOUT };
  }
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
  requestRoom('flow:subscribe', flowId);

export const leaveFlowRoom = async (flowId: string): Promise<RoomAck> =>
  requestRoom('flow:unsubscribe', flowId);
