import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import { isEmailAddress } from '@/utils/email-address';
import { MAX_ALERT_RECIPIENTS } from '@/types/nodes/smtp-alert.types';

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
 * Lee los destinatarios, aceptando la forma HEREDADA de un solo correo.
 *
 * El backend sigue tolerando `notificationRecipient` para no convertir en un
 * 400 la edicion de un flujo guardado antes del cambio; aqui hay que leerlo por
 * el mismo motivo, o el formulario de ese flujo abriria con el campo vacio y el
 * operador creeria que nunca configuro a quien avisar.
 */
const asAddressList = (params: Record<string, unknown>): string[] => {
  const { notificationRecipients, notificationRecipient } = params;

  if (Array.isArray(notificationRecipients)) {
    return notificationRecipients.filter(
      (address): address is string => typeof address === 'string',
    );
  }

  const legacy = asText(notificationRecipient).trim();

  return legacy === '' ? [] : [legacy];
};

/**
 * Lee el modo de los `params` crudos.
 *
 * La columna es `jsonb` y pudo escribirse por SQL directo, asi que un valor
 * fuera del enum cae al modo inmediato en vez de dejar el `q-btn-toggle` sin
 * ninguna opcion marcada, que es un control que el operador no puede arreglar.
 */
const asPauseMode = (value: unknown): PauseTriggerMode =>
  value === PauseTriggerMode.DELAYED ? PauseTriggerMode.DELAYED : PauseTriggerMode.IMMEDIATE;

/** Lee los segundos de los `params` crudos, sin aceptar decimales ni negativos. */
const asSeconds = (value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;

/** Configuracion inicial; se reutiliza en `resetConfig`. */
const buildInitialConfig = (): PauseFlowNodeConfig => ({
  pauseMode: PauseTriggerMode.IMMEDIATE,
  delaySeconds: 0,
  notifyOnPause: false,
  notificationRecipients: [],
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
  const isDelayed = computed<boolean>(() => config.value.pauseMode === PauseTriggerMode.DELAYED);

  /**
   * El retardo elegido no cabe en el tope que acepta el backend.
   *
   * Se expone el diagnostico y no solo un booleano global: el componente lo
   * pinta junto al campo, que es donde el operador puede corregirlo.
   */
  const isDelayOutOfRange = computed<boolean>(
    () =>
      isDelayed.value &&
      (config.value.delaySeconds < 1 || config.value.delaySeconds > MAX_PAUSE_DELAY_SECONDS),
  );

  /**
   * Direcciones que no tienen forma de correo.
   *
   * Se nombran UNA A UNA, como en el nodo de alerta: con tres o cuatro chips en
   * el campo, un "hay un correo invalido" obliga a revisarlos todos a ojo.
   */
  const invalidRecipients = computed<string[]>(() =>
    config.value.notificationRecipients.filter((address) => !isEmailAddress(address)),
  );

  /** Alguno de los destinatarios del aviso no tiene forma de correo. */
  const isRecipientInvalid = computed<boolean>(
    () => config.value.notifyOnPause && invalidRecipients.value.length > 0,
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

    return !config.value.notifyOnPause || config.value.notificationRecipients.length > 0;
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
    // Se recortan y se deduplican aqui y no al escribirlos: pegar una lista
    // separada por comas es la via mas comoda y la mas propensa a dejar
    // espacios sobrantes, y el `@IsEmail` del backend no los tolera.
    const recipients = [
      ...new Set(config.value.notificationRecipients.map((address) => address.trim())),
    ]
      .filter((address) => address !== '')
      .slice(0, MAX_ALERT_RECIPIENTS);
    const message = config.value.customPauseMessage.trim();

    return {
      pauseMode: config.value.pauseMode,
      ...(isDelayed.value && config.value.delaySeconds > 0
        ? { delaySeconds: config.value.delaySeconds }
        : {}),
      ...(config.value.notifyOnPause ? { notifyOnPause: true } : {}),
      // Siempre la clave NUEVA, nunca la heredada: el DTO valida con
      // `forbidNonWhitelisted` pero admite las dos, y reescribir el esquema con
      // la forma vieja dejaria flujos nuevos naciendo ya en el camino de
      // compatibilidad.
      ...(config.value.notifyOnPause && recipients.length > 0
        ? { notificationRecipients: recipients }
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
      notificationRecipients: asAddressList(params),
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
    invalidRecipients,
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
