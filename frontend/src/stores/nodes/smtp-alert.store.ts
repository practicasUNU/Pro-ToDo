import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import { isEmailAddress } from '@/utils/email-address';

import { DEFAULT_ALERT_SUBJECT } from '@/types/nodes/smtp-alert.types';

import type { HydratableNode } from '@stores/nodes/node-store-registry';

import type { SmtpAlertNodeConfig } from '@/types/nodes/smtp-alert.types';

/** Lee una cadena de los `params` crudos del esquema. */
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Lee un arreglo de direcciones de los `params` crudos.
 *
 * La columna es `jsonb` y pudo escribirse por SQL directo, asi que `to` puede
 * faltar, venir como cadena suelta o traer numeros. Se filtra a cadenas en vez
 * de confiar: un `null` dentro del arreglo dejaria un chip vacio imposible de
 * borrar desde la interfaz.
 */
const asAddressList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/** Configuracion inicial; se reutiliza en `resetConfig`. */
const buildInitialConfig = (): SmtpAlertNodeConfig => ({
  to: [],
  cc: [],
  // Pre-poblado y editable. El operador ve desde el primer momento el asunto que
  // se enviara si no toca nada, y puede borrarlo: el backend tiene el mismo
  // defecto y ademas un respaldo si el marcador no resuelve.
  subject: DEFAULT_ALERT_SUBJECT,
  customMessage: '',
});

/** Prefijo del id de Pinia; el sufijo es el `nodeId` del `pipeline_schema`. */
const STORE_ID_PREFIX = 'smtpAlertNode';

// Estado reactivo del nodo DESTINO_SMTP (regla frontend-quasar.md §3.1).
//
// SIN capa de servicios, como el disparador Cron y por el mismo motivo: no hay
// nada que probar contra el backend. No existe endpoint que valide un buzon de
// destino —enviar un correo de prueba desde el asistente seria correo real a una
// persona real cada vez que alguien reabre el paso—, asi que `isConfigValid` se
// resuelve entero en el cliente. Un `smtp-alert.service.ts` que no conociera
// ninguna ruta del backend contradiria su propia definicion
// (`frontend-architecture.md` §2.1).
const smtpAlertSetup = () => {
  const config = ref<SmtpAlertNodeConfig>(buildInitialConfig());

  /**
   * Destinatarios con forma invalida, para senalarlos uno a uno en el campo.
   *
   * Se expone la LISTA y no solo un booleano: con chips, decir "hay un correo
   * mal" obliga al operador a revisarlos todos a ojo. El componente los nombra.
   */
  const invalidRecipients = computed<string[]>(() =>
    [...config.value.to, ...config.value.cc].filter((address) => !isEmailAddress(address)),
  );

  /**
   * Unico dato que el anfitrion consulta para habilitar "Siguiente".
   *
   * `subject` NO entra: tiene defecto en el backend y respaldo si no resuelve,
   * asi que bloquear el asistente por un campo que el sistema sabe rellenar
   * seria un Poka-Yoke al reves. `customMessage` tampoco: es opcional por
   * definicion.
   *
   * A quien avisar, en cambio, no lo puede adivinar nadie, y es exactamente lo
   * que `getIncompleteParams` exige en el backend para ACTIVAR el flujo. Las dos
   * listas dicen lo mismo a proposito.
   */
  const isConfigValid = computed<boolean>(
    () => config.value.to.length > 0 && invalidRecipients.value.length === 0,
  );

  const updateConfig = (patch: Partial<SmtpAlertNodeConfig>): void => {
    config.value = { ...config.value, ...patch };
  };

  /**
   * `params` del nodo para el `pipeline_schema`.
   *
   * LO VACIO SE OMITE en vez de publicarse como `''`. Son dos consecuencias
   * distintas y las dos importan: el DTO valida `@IsNotEmpty` sobre `subject` si
   * la clave viene, asi que un `subject: ''` guardado devolveria un 400 sobre el
   * flujo entero; y el respaldo del backend se activa con la clave AUSENTE, no
   * con la clave vacia. Borrar el asunto en la interfaz tiene que significar
   * "usa el tuyo", y esto es lo que lo traduce.
   *
   * `outputNamespace` NO va aqui: en el esquema es propiedad del nodo, no de sus
   * `params`, y el agregador lo toma de la topologia.
   */
  const toNodeParams = (): Record<string, unknown> => {
    const subject = config.value.subject.trim();
    const customMessage = config.value.customMessage.trim();

    return {
      to: [...config.value.to],
      ...(config.value.cc.length > 0 ? { cc: [...config.value.cc] } : {}),
      ...(subject.length > 0 ? { subject } : {}),
      ...(customMessage.length > 0 ? { customMessage } : {}),
    };
  };

  /**
   * Carga la configuracion de un nodo ya guardado en el `pipeline_schema`.
   *
   * Contrato de ida y vuelta: `hydrateFromNode(n)` seguido de `toNodeParams()`
   * debe reproducir `n.params`. Por eso el asunto ausente se repone con `''` y
   * NO con `DEFAULT_ALERT_SUBJECT`: un nodo que se guardo sin asunto —porque el
   * operador lo borro a proposito— volveria a publicarlo al reabrirlo y cerrarlo,
   * cambiando su configuracion sin que nadie lo pidiera. El defecto es para
   * nodos NUEVOS; reabrir uno existente muestra lo que hay.
   */
  const hydrateFromNode = (node: HydratableNode): void => {
    const { params } = node;

    config.value = {
      to: asAddressList(params.to),
      cc: asAddressList(params.cc),
      subject: asText(params.subject),
      customMessage: asText(params.customMessage),
    };
  };

  const resetConfig = (): void => {
    config.value = buildInitialConfig();
  };

  return {
    config,
    invalidRecipients,
    isConfigValid,
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
 * pipeline puede encadenar dos alertas con destinatarios distintos —una al
 * equipo tecnico y otra al responsable del contenido— y con un id fijo
 * compartirian una sola instancia.
 */
const buildSmtpAlertStore = (nodeId: string) =>
  defineStore(`${STORE_ID_PREFIX}:${nodeId}`, smtpAlertSetup);

/** Instancia del store, para tipar helpers y consumidores sin `any`. */
export type SmtpAlertStore = ReturnType<ReturnType<typeof buildSmtpAlertStore>>;

/** Definiciones ya creadas, indexadas por `nodeId`. */
const definitions = new Map<string, ReturnType<typeof buildSmtpAlertStore>>();

/** Store del nodo DESTINO_SMTP identificado por `nodeId`. */
export const useSmtpAlertStore = (nodeId: string): SmtpAlertStore => {
  const cached = definitions.get(nodeId);

  if (cached !== undefined) return cached();

  const definition = buildSmtpAlertStore(nodeId);
  definitions.set(nodeId, definition);

  if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(definition, import.meta.hot));
  }

  return definition();
};
