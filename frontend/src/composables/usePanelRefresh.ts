import { onBeforeUnmount, onMounted } from 'vue';

import {
  subscribeToCrudMutations,
  subscribeToExecutionEvents,
  subscribeToPricingEvents,
} from '@services/socket-events.service';

import type { CrudEntity, CrudMutationPayload } from '@/types/crud-events';

/** Que debe despertar al panel. */
export interface PanelRefreshOptions {
  /**
   * Entidades cuya mutacion obliga a recargar. Vacio o ausente: ninguna.
   *
   * Se declara en vez de recargar ante CUALQUIER `crud:mutation` porque un
   * panel de telemetria no tiene por que releer sus agregados cada vez que
   * alguien renombra una plantilla.
   */
  readonly entities?: readonly CrudEntity[];
  /**
   * Recargar tambien cuando una ejecucion llega a su desenlace.
   *
   * `flow:completed` es el unico evento del motor que interesa a un panel de
   * agregados: las filas de telemetria se escriben durante la corrida, y hasta
   * que no termina no hay nada nuevo que resumir. Escuchar `node:completed`
   * dispararia una consulta por paso de cada flujo vivo.
   */
  readonly onFlowCompleted?: boolean;
  /**
   * Recargar cuando un ADMIN registra una tarifa de IA (`pricing:updated`).
   *
   * Evento propio y no `crud:mutation` porque un relevo toca DOS filas —la
   * nueva y la que pasa a historico—, y el panel tiene que releer la pagina
   * entera en vez de parchear una.
   */
  readonly onPricingUpdated?: boolean;
}

/**
 * Mantiene un panel de solo lectura al dia sin que nadie recargue la pagina.
 *
 * Se engancha en el COMPONENTE DE VISTA y no en `MainLayout`, al reves que
 * `useCrudSocket` y `useExecutionSocket`: aquellos mantienen colecciones
 * compartidas que deben seguir frescas mientras el operador navega, mientras
 * que esto solo recarga lo que hay en pantalla. Dejarlo vivo fuera de la vista
 * lanzaria consultas por paneles que nadie esta mirando.
 *
 * NO filtra por rol: quien decide que llega es el gateway, que manda las
 * entidades administrativas solo a la sala de administradores.
 *
 * @param reload Accion del store que vuelve a pedir los datos. Se la invoca sin
 *        argumentos, de modo que el panel conserva sus filtros actuales.
 */
export const usePanelRefresh = (
  reload: () => void | Promise<void>,
  options: PanelRefreshOptions = {},
): void => {
  const watched = new Set<CrudEntity>(options.entities ?? []);

  let unsubscribeCrud: (() => void) | null = null;
  let unsubscribeExecution: (() => void) | null = null;
  let unsubscribePricing: (() => void) | null = null;

  /**
   * Recarga sin propagar el fallo.
   *
   * Un evento del socket no tiene a nadie a quien devolverle un rechazo: la
   * accion del store ya avisa al usuario por su cuenta, y dejar escapar la
   * promesa dejaria un `unhandledrejection` en la consola cada vez que la red
   * falla con el panel abierto.
   */
  const refresh = (): void => {
    void Promise.resolve(reload()).catch(() => undefined);
  };

  const onMutation = (payload: CrudMutationPayload): void => {
    if (watched.has(payload.entity)) {
      refresh();
    }
  };

  onMounted(() => {
    if (watched.size > 0) {
      unsubscribeCrud = subscribeToCrudMutations(onMutation);
    }

    if (options.onFlowCompleted === true) {
      unsubscribeExecution = subscribeToExecutionEvents({
        onFlowCompleted: () => refresh(),
      });
    }

    if (options.onPricingUpdated === true) {
      unsubscribePricing = subscribeToPricingEvents(() => refresh());
    }
  });

  // Sin esta baja, cada montaje apilaria un juego mas de escuchas y un solo
  // evento provocaria tantas consultas como veces se hubiera abierto el panel.
  onBeforeUnmount(() => {
    unsubscribeCrud?.();
    unsubscribeExecution?.();
    unsubscribePricing?.();
    unsubscribeCrud = null;
    unsubscribeExecution = null;
    unsubscribePricing = null;
  });
};
