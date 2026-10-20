import { onBeforeUnmount, onMounted } from 'vue';

import { useQuasar } from 'quasar';

import { subscribeToExecutionEvents, subscribeToReconnect } from '@services/socket-events.service';
import { useCanvasStore } from '@stores/canvas.store';
import { useExecutionStore } from '@stores/execution.store';

import { ExecutionState } from '@/types/execution';
import { ALERTING_SEVERITIES, notifyClassesOf, presentationOf } from '@/utils/alert-categorizer';

import type {
  FlowCompletedEvent,
  NodeCompletedEvent,
  NodeStartedEvent,
  FlowDiscardedEvent,
  FlowPausedEvent,
  FlowResumedEvent,
  NodeErrorEvent,
} from '@/types/execution';

/** Cuanto permanece en pantalla el aviso de exito, en milisegundos. */
const NOTIFY_SUCCESS_TIMEOUT_MS = 5000;

/** Longitud del identificador abreviado que se muestra en los avisos. */
const SHORT_ID_LENGTH = 8;

/** `7c9e6679-7425-...` -> `7c9e6679`. Un UUID entero no cabe en un toast. */
const shortId = (id: string): string => id.slice(0, SHORT_ID_LENGTH);

/**
 * Como nombrar un flujo en un aviso.
 *
 * El nombre solo llega si quien despacho la ejecucion se lo paso al motor, asi
 * que la caida al identificador abreviado no es defensiva: es el caso real de
 * una ejecucion lanzada sin `flowName`.
 */
const describeFlow = (flowName: string | undefined, flowId: string): string =>
  flowName ?? `${shortId(flowId)}...`;

/**
 * Engancha el store de ejecuciones al canal WebSocket mientras viva el
 * componente anfitrion, y traduce cada evento a retroalimentacion visual.
 *
 * El store no conoce el transporte y el servicio no conoce el store: este
 * composable es la costura entre ambos, y por eso es el unico sitio donde
 * aparecen juntos. Tambien es donde entra Quasar: el store se mantiene en la
 * capa de logica de negocio (`frontend-architecture.md` §2.1) y por eso NO
 * notifica el mismo — se limita a parchear su estado.
 *
 * Se invoca desde `MainLayout.vue`, que envuelve todas las rutas autenticadas y
 * se desmonta al salir a /login — exactamente el mismo enganche que
 * `useSessionMonitor`. Ese anfitrion es ademas lo que hace valido el
 * `useQuasar()` de aqui: exige contexto de componente.
 */
export const useExecutionSocket = (): void => {
  const $q = useQuasar();
  const executionStore = useExecutionStore();
  const canvasStore = useCanvasStore();

  let unsubscribe: (() => void) | null = null;
  let unsubscribeReconnect: (() => void) | null = null;

  /**
   * Reintento manual (CU-09) lanzado desde el propio aviso.
   *
   * El store propaga la excepcion a proposito; es aqui donde se convierte en un
   * mensaje: el 409 (ya no esta PAUSADO), el 400 (su nodo desaparecio del
   * esquema) y el 429 (motor saturado) llegan con textos distintos del backend.
   */
  const resumeFromNotification = async (executionId: string): Promise<void> => {
    try {
      await executionStore.resumeExecution(executionId);

      $q.notify({
        type: 'positive',
        icon: 'play_arrow',
        message: 'Flujo reanudado exitosamente',
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error al reanudar flujo';

      $q.notify({
        type: 'negative',
        icon: 'error',
        message: 'Fallo al reanudar',
        caption: message,
      });
    }
  };

  /**
   * El motor detuvo la ejecucion: queda reanudable.
   *
   * Aviso PERSISTENTE (`timeout: 0`) porque lleva la accion de reanudar: uno que
   * se desvanece solo convertiria el reintento en cuestion de haber estado
   * mirando la pantalla en ese momento.
   *
   * El paso detenido es `activeCursor`; `FlowPausedEvent` no trae `nodeId`.
   */
  const onFlowPaused = (event: FlowPausedEvent): void => {
    executionStore.handleFlowPaused(event);
    // El canvas tambien escucha la pausa: es el UNICO cierre del nodo en
    // vuelo, porque el motor no emite un `node:aborted`.
    canvasStore.handleFlowPaused(event);

    // --- Pausa DELIBERADA: otro aviso entero, no un matiz del mismo.
    //
    // No hay incidencia que diagnosticar, ni severidad, ni nada que corregir
    // antes de reanudar. Pasarla por el aviso de abajo la anunciaria con
    // `GRAVE` y una franja roja, mandando al operador a buscar una averia que
    // no existe: el resto del payload es indistinguible del de una caida.
    if (event.isProgrammedPause === true) {
      $q.notify({
        type: 'info',
        icon: 'pause_circle',
        multiLine: true,
        message: `Flujo en pausa programada: ${describeFlow(event.flowName, event.flowId)}`,
        caption: `Detenido en "${event.pausedStepId ?? event.activeCursor}". Continuara cuando alguien lo reanude.`,
        timeout: 0,
        actions: [
          {
            label: 'Reanudar',
            color: 'white',
            handler: () => {
              void resumeFromNotification(event.executionId);
            },
          },
          { label: 'Cerrar', color: 'white', flat: true },
        ],
      });

      return;
    }

    // El nodo se nombra con su TIPO entre parentesis cuando el evento lo trae:
    // `nodo_3` no le dice nada a nadie, `nodo_3 (DESTINO_DRUPAL)` manda al
    // operador al configurador correcto sin abrir el flujo.
    const node =
      event.nodeType === undefined
        ? `"${event.activeCursor}"`
        : `"${event.activeCursor}" (${event.nodeType})`;

    // El codigo va DELANTE del mensaje: es el contrato estable que identifica
    // el fallo, mientras que el texto cambia con cada version de la estrategia.
    const detail = [event.errorCode, event.errorMessage ?? 'sin detalle']
      .filter((part): part is string => part !== undefined)
      .join(': ');

    // Un unico intento no se anuncia: es el caso normal y el distintivo solo
    // sirve para avisar de lo contrario —que ya se insistio y no funciono—,
    // que es lo que dice al operador si reanudar ahora mismo tiene sentido.
    const attemptBadge =
      event.attempts !== undefined && event.attempts > 1
        ? ` (fallo tras ${event.attempts} intentos)`
        : '';

    $q.notify({
      type: 'warning',
      icon: 'pause_circle',
      multiLine: true,
      message: `Flujo pausado: ${describeFlow(event.flowName, event.flowId)} — nodo ${node}${attemptBadge}`,
      caption: [`${event.severity ?? 'GRAVE'} · ${detail}`, event.errorDetail]
        .filter((part): part is string => part !== undefined)
        .join('\n'),
      // El acento sigue a la severidad REAL: una pausa por URGENTE se pintaba
      // en ambar como una GRAVE, pese a que no admite reintento.
      classes: notifyClassesOf(event.severity),
      timeout: 0,
      actions: [
        {
          label: 'Reanudar',
          color: 'white',
          handler: () => {
            void resumeFromNotification(event.executionId);
          },
        },
        // «Cerrar» y no «Descartar»: descartar una ejecucion exige la cuenta
        // atras de cinco segundos (regla §4) y vive en la tabla de flujos. Un
        // boton de toast que pareciera hacerlo seria justo el atajo que esa
        // regla prohibe.
        { label: 'Cerrar', color: 'white', flat: true },
      ],
    });
  };

  /** Alguien relanzo la ejecucion sobre la misma fila. */
  const onFlowResumed = (event: FlowResumedEvent): void => {
    executionStore.handleFlowResumed(event);
    // El canvas tambien: sin esto se queda congelado en la foto del intento
    // anterior —el nodo pausado en ambar y los posteriores completados— hasta
    // que alguien recarga la pagina.
    canvasStore.handleFlowResumed(event);

    // Por correo el aviso cambia de tono y de icono: nadie esta mirando la
    // pantalla cuando llega, asi que tiene que decir de donde salio la orden.
    const byEmail = event.isEmailResume === true;

    $q.notify({
      type: byEmail ? 'info' : 'positive',
      icon: byEmail ? 'mail' : 'play_arrow',
      message: byEmail
        ? `Flujo reanudado via correo por ${event.resumedBy.email}`
        : `Flujo ${shortId(event.flowId)}... en marcha`,
      caption: `Reanudado en el paso "${event.activeCursor}" por ${event.resumedBy.email}.`,
    });
  };

  /** Un operador renuncio a reanudarla; su flujo queda fuera del sondeo. */
  const onFlowDiscarded = (event: FlowDiscardedEvent): void => {
    executionStore.handleFlowDiscarded(event);

    $q.notify({
      type: 'info',
      icon: 'delete_sweep',
      message: `Ejecucion descartada en el paso "${event.lastCursor}"`,
      caption: event.workflowDeactivated
        ? 'El flujo queda inactivo: habilitalo cuando este corregido.'
        : 'El flujo sigue habilitado.',
    });
  };

  /**
   * La ejecucion llego a un estado terminal.
   *
   * Tres tonos para un solo evento, y la distincion no es cosmetica: un
   * `OMITIDO` —el buzon no traia nada— en verde haria creer que se publico
   * algo, y en rojo mandaria a investigar una ejecucion que funciono.
   */
  const onFlowCompleted = (event: FlowCompletedEvent): void => {
    executionStore.handleFlowCompleted(event);
    // Apaga las cajas que seguian corriendo, por el mismo motivo que la pausa.
    canvasStore.handleFlowCompleted(event);

    const flow = describeFlow(event.flowName, event.flowId);

    if (event.finalState === ExecutionState.EXITOSO) {
      $q.notify({
        type: 'positive',
        icon: 'check_circle',
        // Se desvanece solo: a diferencia de la pausa, no lleva ninguna accion
        // que el operador deba poder pulsar mas tarde.
        timeout: NOTIFY_SUCCESS_TIMEOUT_MS,
        message: `Flujo "${flow}" completado con exito.`,
        caption: 'El pipeline recorrio todos sus nodos sin incidencias.',
      });

      return;
    }

    if (event.finalState === ExecutionState.OMITIDO) {
      $q.notify({
        type: 'info',
        icon: 'inbox',
        message: `Flujo sin trabajo: ${flow}`,
        caption: 'Termino sin nada que procesar; no hay nada que revisar.',
      });

      return;
    }

    $q.notify({
      type: 'negative',
      icon: 'report',
      message: `Flujo fallido: ${flow}`,
      caption: event.failureReason ?? 'Sin motivo registrado.',
      classes: notifyClassesOf('URGENTE'),
    });
  };

  /**
   * Un nodo termino sin exito. NO implica que el flujo se haya detenido: un
   * LEVE con reintentos emite esto y sigue adelante, de ahi el filtro.
   */
  const onNodeError = (event: NodeErrorEvent): void => {
    executionStore.handleNodeError(event);

    // El canvas lo recibe SIEMPRE, al margen del filtro de severidad de abajo.
    // Son dos preguntas distintas: aquel decide si hay que interrumpir al
    // operador con un aviso, y esto solo pinta la caja de rojo. Un LEVE no
    // merece notificacion, pero mientras se reintenta la tarjeta estaba
    // mintiendo —seguia en «Procesando»— y esa es justo la informacion que el
    // canvas existe para dar.
    canvasStore.handleNodeError(event);

    if (!ALERTING_SEVERITIES.includes(event.severity)) {
      return;
    }

    // La presentacion sale del categorizador y no de literales: hasta ahora un
    // GRAVE y un URGENTE se pintaban EXACTAMENTE IGUAL, de modo que un fallo
    // que el motor va a reintentar y uno irrecuperable eran indistinguibles.
    const presentation = presentationOf(event.severity);

    $q.notify({
      type: presentation.type,
      icon: presentation.icon,
      message: `Fallo ${event.severity} en "${event.nodeId}"`,
      caption: `Intento ${event.attempt} · ${event.errorCode ?? 'sin codigo'}: ${event.errorMessage ?? 'sin detalle'}`,
      classes: notifyClassesOf(event.severity),
    });
  };

  /**
   * El ciclo de vida del nodo alimenta SOLO al canvas, sin aviso al usuario.
   *
   * Es el par mas voluminoso del canal —dos eventos por intento de cada nodo—,
   * de modo que notificarlo sepultaria los avisos que si piden una accion. El
   * propio canvas descarta lo que no sea de su flujo, porque la tabla de
   * `/flujos` mantiene abiertas las salas de todos.
   */
  const onNodeStarted = (event: NodeStartedEvent): void => {
    canvasStore.handleNodeStarted(event);
    // Y el store de ejecuciones, que es de donde la TABLA de flujos saca su
    // insignia: sin esto, una ejecucion recien disparada no aparecia ahi hasta
    // que se pausaba o terminaba.
    executionStore.handleNodeStarted(event);
  };

  const onNodeCompleted = (event: NodeCompletedEvent): void => {
    canvasStore.handleNodeCompleted(event);
  };

  /**
   * Vuelve a leer el estado real del canvas cada vez que el socket se reconecta.
   *
   * LO QUE CIERRA EL HUECO DE UN MICRO-CORTE. El boot ya vuelve a entrar en las
   * salas al reconectar, pero nadie reenvia lo ocurrido MIENTRAS no habia
   * conexion: un `node:completed` o un `flow:paused` emitidos durante el corte
   * se pierden para todos, y el canvas se quedaba con la ultima foto que le
   * llego —cajas girando un spinner por un nodo que ya habia terminado— hasta
   * que el operador recargaba a mano.
   *
   * El reparto con el boot es deliberado: aquel recupera las SALAS, esto
   * recupera el ESTADO. Duplicar aqui la reinscripcion dejaria dos sitios
   * pidiendo lo mismo.
   *
   * Solo el canvas: la tabla de `/flujos` se mantiene al dia por
   * `crud:mutation`, que el backend difunde en cada cambio de fila.
   */
  const onReconnected = (): void => {
    void canvasStore.syncCurrentExecution();
  };

  onMounted(() => {
    unsubscribe = subscribeToExecutionEvents({
      onFlowPaused,
      onFlowResumed,
      onFlowDiscarded,
      onFlowCompleted,
      onNodeError,
      onNodeStarted,
      onNodeCompleted,
    });

    unsubscribeReconnect = subscribeToReconnect(onReconnected);
  });

  // Sin esta baja, cada montaje apilaria un juego mas de listeners sobre los
  // mismos eventos y el store procesaria cada evento tantas veces como veces se
  // hubiera montado el layout.
  onBeforeUnmount(() => {
    unsubscribe?.();
    unsubscribe = null;

    unsubscribeReconnect?.();
    unsubscribeReconnect = null;
  });
};
