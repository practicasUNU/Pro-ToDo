import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import { isEmailAddress } from '@/utils/email-address';

import {
  DEFAULT_PAUSE_DELAY_SECONDS,
  MAX_PAUSE_DELAY_SECONDS,
  PauseTriggerMode,
} from '@/types/nodes/pause-flow.types';

import type { HydratableNode } from '@stores/nodes/node-store-registry';

import type { PauseFlowNodeConfig } from '@/types/nodes/pause-flow.types';

/** Lee una cadena de los `params` crudos del esquema. */
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Lee el modo de los `params` crudos.
 *
 * La columna es `jsonb` y pudo escribirse por SQL directo, asi que un valor
 * fuera del enum cae al modo inmediato en vez de dejar el `q-btn-toggle` sin
 * ninguna opcion marcada, que es un control que el operador no puede arreglar.
 */
const asPauseMode = (value: unknown): PauseTriggerMode =>
  value === PauseTriggerMode.DELAYED
    ? PauseTriggerMode.DELAYED
    : PauseTriggerMode.IMMEDIATE;

/** Lee los segundos de los `params` crudos, sin aceptar decimales ni negativos. */
const asSeconds = (value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;

/** Configuracion inicial; se reutiliza en `resetConfig`. */
const buildInitialConfig = (): PauseFlowNodeConfig => ({
  pauseMode: PauseTriggerMode.IMMEDIATE,
  delaySeconds: 0,
  notifyOnPause: false,
  notificationRecipient: '',
  customPauseMessage: '',
});

/** Prefijo del id de Pinia; el sufijo es el `nodeId` del `pipeline_schema`. */
const STORE_ID_PREFIX = 'pauseFlowNode';

// Estado reactivo del nodo PAUSA_FLOW (regla frontend-quasar.md §3.1).
//
// SIN capa de servicios, igual que el nodo de alerta y el disparador Cron: no
// hay ninguna ruta del backend que este nodo pueda probar —pausar es una
// decision del motor en ejecucion, no algo que se consulte desde el asistente—,
// y un `pause-flow.service.ts` que no conociera ninguna ruta contradiria su
// propia definicion (`frontend-architecture.md` §2.1).
const pauseFlowSetup = () => {
  const config = ref<PauseFlowNodeConfig>(buildInitialConfig());

  /** `true` cuando el operador eligio esperar antes de congelar el flujo. */
  const isDelayed = computed<boolean>(
    () => config.value.pauseMode === PauseTriggerMode.DELAYED,
  );

  /**
   * El retardo elegido no cabe en el tope que acepta el backend.
   *
   * Se expone el diagnostico y no solo un booleano global: el componente lo
   * pinta junto al campo, que es donde el operador puede corregirlo.
   */
  const isDelayOutOfRange = computed<boolean>(
    () =>
      isDelayed.value &&
      (config.value.delaySeconds < 1 ||
        config.value.delaySeconds > MAX_PAUSE_DELAY_SECONDS),
  );

  /** El destinatario del aviso no tiene forma de correo. */
  const isRecipientInvalid = computed<boolean>(
    () =>
      config.value.notifyOnPause &&
      config.value.notificationRecipient.trim().length > 0 &&
      !isEmailAddress(config.value.notificationRecipient.trim()),
  );

  /**
   * Unico dato que el anfitrion consulta para habilitar "Siguiente".
   *
   * Un nodo de pausa SIN CONFIGURAR es valido, y esa es la diferencia con los
   * demas: sabe hacer su trabajo sin que nadie le diga nada. Solo se exige lo
   * que el propio operador activo —el destinatario si pidio aviso, los segundos
   * si eligio retardo—, que es exactamente lo que `getIncompleteParams` exige en
   * el backend para ACTIVAR el flujo. Las dos listas dicen lo mismo a proposito.
   */
  const isConfigValid = computed<boolean>(() => {
    if (isDelayOutOfRange.value || isRecipientInvalid.value) {
      return false;
    }

    return (
      !config.value.notifyOnPause ||
      config.value.notificationRecipient.trim().length > 0
    );
  });

  /**
   * Cambia el modo, proponiendo un retardo al pasar a diferido.
   *
   * Se propone en vez de dejarlo en cero porque un cero no es un retardo
   * valido: el operador tendria que teclear un numero para que el formulario
   * dejara de estar en rojo nada mas pulsar el conmutador.
   */
  const setPauseMode = (pauseMode: PauseTriggerMode): void => {
    config.value = {
      ...config.value,
      pauseMode,
      delaySeconds:
        pauseMode === PauseTriggerMode.DELAYED && config.value.delaySeconds < 1
          ? DEFAULT_PAUSE_DELAY_SECONDS
          : config.value.delaySeconds,
    };
  };

  const updateConfig = (patch: Partial<PauseFlowNodeConfig>): void => {
    config.value = { ...config.value, ...patch };
  };

  /**
   * `params` del nodo para el `pipeline_schema`.
   *
   * LO VACIO SE OMITE en vez de publicarse. El DTO valida `@IsNotEmpty` sobre
   * `customPauseMessage` si la clave viene, asi que una cadena vacia guardada
   * devolveria un 400 sobre el flujo entero.
   *
   * `delaySeconds` SOLO viaja con el modo diferido, en espejo de lo que hace
   * `resolvePauseFlowConfig` en el backend: un retardo huerfano de cuando el
   * operador probo esa opcion y volvio a la inmediata confundiria a quien
   * reabriera el nodo.
   */
  const toNodeParams = (): Record<string, unknown> => {
    const recipient = config.value.notificationRecipient.trim();
    const message = config.value.customPauseMessage.trim();

    return {
      pauseMode: config.value.pauseMode,
      ...(isDelayed.value && config.value.delaySeconds > 0
        ? { delaySeconds: config.value.delaySeconds }
        : {}),
      ...(config.value.notifyOnPause ? { notifyOnPause: true } : {}),
      ...(config.value.notifyOnPause && recipient.length > 0
        ? { notificationRecipient: recipient }
        : {}),
      ...(message.length > 0 ? { customPauseMessage: message } : {}),
    };
  };

  /**
   * Carga la configuracion de un nodo ya guardado en el `pipeline_schema`.
   *
   * Contrato de ida y vuelta: `hydrateFromNode(n)` seguido de `toNodeParams()`
   * debe reproducir `n.params`.
   */
  const hydrateFromNode = (node: HydratableNode): void => {
    const { params } = node;

    config.value = {
      pauseMode: asPauseMode(params.pauseMode),
      delaySeconds: asSeconds(params.delaySeconds),
      notifyOnPause: params.notifyOnPause === true,
      notificationRecipient: asText(params.notificationRecipient),
      customPauseMessage: asText(params.customPauseMessage),
    };
  };

  const resetConfig = (): void => {
    config.value = buildInitialConfig();
  };

  return {
    config,
    isDelayed,
    isDelayOutOfRange,
    isRecipientInvalid,
    isConfigValid,
    setPauseMode,
    updateConfig,
    toNodeParams,
    hydrateFromNode,
    resetConfig,
  };
};

/**
 * Definicion de Pinia para UN nodo concreto.
 *
 * El id lleva el `nodeId` dentro por el mismo motivo que en los demas nodos: un
 * flujo puede encadenar dos pausas —una esperando revision y otra esperando una
 * ventana de publicacion— y con un id fijo compartirian una sola instancia.
 */
const buildPauseFlowStore = (nodeId: string) =>
  defineStore(`${STORE_ID_PREFIX}:${nodeId}`, pauseFlowSetup);

/** Instancia del store, para tipar helpers y consumidores sin `any`. */
export type PauseFlowStore = ReturnType<ReturnType<typeof buildPauseFlowStore>>;

/** Definiciones ya creadas, indexadas por `nodeId`. */
const definitions = new Map<string, ReturnType<typeof buildPauseFlowStore>>();

/** Store del nodo PAUSA_FLOW identificado por `nodeId`. */
export const usePauseFlowStore = (nodeId: string): PauseFlowStore => {
  const cached = definitions.get(nodeId);

  if (cached !== undefined) return cached();

  const definition = buildPauseFlowStore(nodeId);
  definitions.set(nodeId, definition);

  if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(definition, import.meta.hot));
  }

  return definition();
};
