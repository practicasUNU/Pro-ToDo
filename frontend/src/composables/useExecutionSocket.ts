import { onBeforeUnmount, onMounted } from 'vue';

import { useQuasar } from 'quasar';

import { subscribeToExecutionEvents } from '@services/socket-events.service';
import { useExecutionStore } from '@stores/execution.store';

import type {
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

/** Longitud del identificador abreviado que se muestra en los avisos. */
const SHORT_ID_LENGTH = 8;

/** `7c9e6679-7425-...` -> `7c9e6679`. Un UUID entero no cabe en un toast. */
const shortId = (id: string): string => id.slice(0, SHORT_ID_LENGTH);

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
      const message =
        error instanceof Error ? error.message : 'Error al reanudar flujo';

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

    $q.notify({
      type: 'warning',
      icon: 'pause_circle',
      message: `Flujo ${shortId(event.flowId)}... en pausa`,
      caption: `Detenido en paso "${event.activeCursor}": ${event.errorMessage ?? 'sin detalle'}`,
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
        { label: 'Descartar', color: 'white', flat: true },
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
