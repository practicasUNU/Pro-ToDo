import { onBeforeUnmount, onMounted } from 'vue';

import { subscribeToExecutionEvents } from '@services/socket-events.service';
import { useExecutionStore } from '@stores/execution.store';

/**
 * Engancha el store de ejecuciones al canal WebSocket mientras viva el
 * componente anfitrion.
 *
 * El store no conoce el transporte y el servicio no conoce el store: este
 * composable es la costura entre ambos, y por eso es el unico sitio donde
 * aparecen juntos.
 *
 * Se invoca desde `MainLayout.vue`, que envuelve todas las rutas autenticadas y
 * se desmonta al salir a /login — exactamente el mismo enganche que
 * `useSessionMonitor`.
 */
export const useExecutionSocket = (): void => {
  const executionStore = useExecutionStore();

  let unsubscribe: (() => void) | null = null;

  onMounted(() => {
    unsubscribe = subscribeToExecutionEvents({
      onFlowPaused: executionStore.handleFlowPaused,
      onFlowResumed: executionStore.handleFlowResumed,
      onNodeError: executionStore.handleNodeError,
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
