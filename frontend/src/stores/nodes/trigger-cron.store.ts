import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import type { HydratableNode } from '@stores/nodes/node-store-registry';

/** Zona horaria por defecto, la misma que asume el backend. */
export const DEFAULT_CRON_TIMEZONE = 'Europe/Madrid';

/** Namespace por defecto bajo el que el nodo declara escribir su salida. */
export const DEFAULT_CRON_OUTPUT_NAMESPACE = 'cron_trigger';

/**
 * Numero de campos exigido, replicado del DTO del backend.
 *
 * Sin esta copia el formulario dejaria enviar una expresion de seis campos que
 * el backend rechaza: el operador veria un 400 donde deberia haber visto una
 * regla de campo.
 */
export const CRON_EXPRESSION_FIELD_COUNT = 5;

/**
 * Zonas horarias ofrecidas por el selector.
 *
 * Lista cerrada y no entrada libre (Poka-Yoke, `frontend-quasar.md` §4): un
 * nombre IANA mal escrito no se detecta a simple vista, y el fallo aparece
 * mucho despues, cuando el flujo se dispara a la hora equivocada. Se cubren la
 * zona de la organizacion, UTC y las del resto de la peninsula e islas.
 */
export const CRON_TIMEZONE_OPTIONS: readonly string[] = [
  'Europe/Madrid',
  'Atlantic/Canary',
  'UTC',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'America/New_York',
  'America/Mexico_City',
  'America/Bogota',
  'America/Argentina/Buenos_Aires',
];

/**
 * Valida la expresion sin la libreria `cron`, que es de backend.
 *
 * Comprueba el recuento de campos y que cada uno solo use los caracteres del
 * formato estandar. NO reproduce el analisis completo: los rangos fuera de
 * limite (`99 * * * *`) los sigue rechazando el backend. El objetivo aqui es
 * atrapar el error frecuente —contar mal los campos, escribir `@daily`, dejar
 * texto libre— sin duplicar un analizador entero en el cliente.
 */
export const isLikelyCronExpression = (value: string): boolean => {
  const expression = value.trim();

  if (expression === '' || expression.startsWith('@')) {
    return false;
  }

  const fields = expression.split(/\s+/);

  if (fields.length !== CRON_EXPRESSION_FIELD_COUNT) {
    return false;
  }

  return fields.every((field) => /^[0-9*/,\-A-Za-z]+$/.test(field));
};

/** `params` que el nodo aporta al `pipeline_schema`. */
export interface TriggerCronConfig {
  cronExpression: string;
  timeZone: string;
}

/**
 * Lee una cadena de los `params` crudos del esquema.
 *
 * La columna es `jsonb` y pudo escribirse por SQL directo, asi que un campo
 * puede faltar o venir con otro tipo. Se normaliza a `''` en vez de propagar
 * `undefined`, que dejaria el `<q-input>` como campo descontrolado en Vue.
 */
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Configuracion inicial; se reutiliza en `resetConfig`. */
const buildInitialConfig = (): TriggerCronConfig => ({
  cronExpression: '',
  timeZone: DEFAULT_CRON_TIMEZONE,
});

/** Prefijo del id de Pinia; el sufijo es el `nodeId` del `pipeline_schema`. */
const STORE_ID_PREFIX = 'triggerCronNode';

// Estado reactivo del nodo TRIGGER_CRON (regla frontend-quasar.md §3.1).
//
// A diferencia del disparador IMAP, aqui no hay nada que "probar" contra un
// servicio externo: la programacion no depende de credenciales ni de red, asi
// que `isConfigValid` se resuelve entero en el cliente y el store no necesita
// capa de servicios.
const triggerCronSetup = () => {
  const config = ref<TriggerCronConfig>(buildInitialConfig());

  const isConfigValid = computed<boolean>(
    () =>
      isLikelyCronExpression(config.value.cronExpression) &&
      CRON_TIMEZONE_OPTIONS.includes(config.value.timeZone),
  );

  const patchConfig = (patch: Partial<TriggerCronConfig>): void => {
    config.value = { ...config.value, ...patch };
  };

  /**
   * `params` del nodo para el `pipeline_schema`.
   *
   * Se recorta la expresion por el mismo motivo que el backend la normaliza: la
   * reconciliacion del planificador compara configuraciones por JSON, y un
   * espacio de sobra contaria como cambio y reinscribiria el temporizador.
   *
   * `outputNamespace` NO va aqui: en el esquema es propiedad del nodo, no de
   * sus `params`, y el agregador lo toma de la topologia.
   */
  const toNodeParams = (): Record<string, unknown> => ({
    cronExpression: config.value.cronExpression.trim(),
    timeZone: config.value.timeZone,
  });

  /**
   * Carga la configuracion de un nodo ya guardado en el `pipeline_schema`.
   *
   * Contrato de ida y vuelta: `hydrateFromNode(n)` seguido de `toNodeParams()`
   * debe reproducir `n.params`. La zona horaria ausente se repone con el mismo
   * default que aplica el backend, no con cadena vacia, para que el selector no
   * quede sin seleccion en un nodo que si tiene una zona efectiva.
   */
  const hydrateFromNode = (node: HydratableNode): void => {
    const params = node.params;

    config.value = {
      cronExpression: asText(params.cronExpression),
      timeZone: asText(params.timeZone) || DEFAULT_CRON_TIMEZONE,
    };
  };

  const resetConfig = (): void => {
    config.value = buildInitialConfig();
  };

  return {
    config,
    isConfigValid,
    patchConfig,
    toNodeParams,
    hydrateFromNode,
    resetConfig,
  };
};

/**
 * Definicion de Pinia para UN nodo concreto.
 *
 * El id lleva el `nodeId` dentro por el mismo motivo que en el disparador IMAP:
 * un pipeline puede encadenar dos programaciones distintas, y con un id fijo
 * compartirian una sola instancia.
 */
const buildTriggerCronStore = (nodeId: string) =>
  defineStore(`${STORE_ID_PREFIX}:${nodeId}`, triggerCronSetup);

/** Instancia del store, para tipar helpers y consumidores sin `any`. */
export type TriggerCronStore = ReturnType<ReturnType<typeof buildTriggerCronStore>>;

/** Definiciones ya creadas, indexadas por `nodeId`. */
const definitions = new Map<string, ReturnType<typeof buildTriggerCronStore>>();

/** Store del nodo TRIGGER_CRON identificado por `nodeId`. */
export const useTriggerCronStore = (nodeId: string): TriggerCronStore => {
  const cached = definitions.get(nodeId);

  if (cached !== undefined) return cached();

  const definition = buildTriggerCronStore(nodeId);
  definitions.set(nodeId, definition);

  if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(definition, import.meta.hot));
  }

  return definition();
};
