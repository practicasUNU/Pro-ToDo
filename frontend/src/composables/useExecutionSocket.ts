import { onBeforeUnmount, onMounted } from 'vue';

import { useQuasar } from 'quasar';

import { subscribeToExecutionEvents } from '@services/socket-events.service';
import { useExecutionStore } from '@stores/execution.store';

import { ExecutionState } from '@/types/execution';

import type {
  FlowCompletedEvent,
  FlowDiscardedEvent,
  FlowPausedEvent,
  FlowResumedEvent,
  NodeErrorEvent,
  NodeErrorSeverity,
} from '@/types/execution';

/**
 * Severidades que merecen interrumpir al operador con un aviso flotante.
 *
 * Un `LEVE` queda fuera a proposito: lo emite un nodo que va a reintentar y el
 * flujo sigue avanzando. Notificarlo llenaria la pantalla de avisos por algo
 * que se resuelve solo, y el ruido acabaria tapando al `URGENTE` que si importa.
 */
const ALERTING_SEVERITIES: readonly NodeErrorSeverity[] = ['GRAVE', 'URGENTE'];

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

  let unsubscribe: (() => void) | null = null;

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
      message: `⚠️ Flujo pausado: ${describeFlow(event.flowName, event.flowId)} — nodo ${node}${attemptBadge}`,
      caption: [`${event.severity ?? 'GRAVE'} · ${detail}`, event.errorDetail]
        .filter((part): part is string => part !== undefined)
        .join('\n'),
      classes: 'pd-card pd-card--accent pd-accent-grave',
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

    $q.notify({
      type: 'positive',
      icon: 'play_arrow',
      message: `Flujo ${shortId(event.flowId)}... en marcha`,
      caption: `Reanudado en el paso "${event.activeCursor}" por ${event.resumedBy}.`,
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

    const flow = describeFlow(event.flowName, event.flowId);

    if (event.finalState === ExecutionState.EXITOSO) {
      $q.notify({
        type: 'positive',
        icon: 'check_circle',
        // Se desvanece solo: a diferencia de la pausa, no lleva ninguna accion
        // que el operador deba poder pulsar mas tarde.
        timeout: NOTIFY_SUCCESS_TIMEOUT_MS,
        message: `✅ Flujo "${flow}" completado con exito.`,
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
      classes: 'pd-card pd-card--accent pd-accent-urgente',
    });
  };

  /**
   * Un nodo termino sin exito. NO implica que el flujo se haya detenido: un
   * LEVE con reintentos emite esto y sigue adelante, de ahi el filtro.
   */
  const onNodeError = (event: NodeErrorEvent): void => {
    executionStore.handleNodeError(event);

    if (!ALERTING_SEVERITIES.includes(event.severity)) {
      return;
    }

    $q.notify({
      type: 'negative',
      icon: 'report',
      message: `Fallo ${event.severity} en "${event.nodeId}"`,
      caption: `Intento ${event.attempt} · ${event.errorCode ?? 'sin codigo'}: ${event.errorMessage ?? 'sin detalle'}`,
      classes: 'pd-card pd-card--accent pd-accent-urgente',
    });
  };

  onMounted(() => {
    unsubscribe = subscribeToExecutionEvents({
      onFlowPaused,
      onFlowResumed,
      onFlowDiscarded,
      onFlowCompleted,
      onNodeError,
    });
  });

  // Sin esta baja, cada montaje apilaria un juego mas de listeners sobre los
  // mismos eventos y el store procesaria cada evento tantas veces como veces se
  // hubiera montado el layout.
  onBeforeUnmount(() => {
    unsubscribe?.();
    unsubscribe = null;
  });
};
