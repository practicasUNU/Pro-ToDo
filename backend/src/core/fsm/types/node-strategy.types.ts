import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type { NodeType } from '@core/fsm/types/pipeline-schema.types';

/**
 * Contrato polimorfico de los nodos del motor FSM.
 *
 * Es el punto de extension del sistema: anadir un tipo de nodo consiste en
 * implementar `INodeStrategy` y registrarla en `NodeStrategyFactory`, sin tocar
 * el bucle de `FsmEngineService`. Replica `architecture-patterns.md` §2.
 */

/**
 * Gravedad de un fallo de nodo. Gobierna el control de flujo, no solo la traza:
 * `FsmEngineService` unicamente reintenta los `GRAVE`. Coincide con el tipo
 * `enum_nivel_error` de PostgreSQL, donde acaban las alertas.
 */
export type NodeErrorSeverity = 'LEVE' | 'GRAVE' | 'URGENTE';

/**
 * Codigos de fallo que emite el propio motor.
 *
 * Los de las estrategias viven junto a cada una: el motor no debe conocerlos, y
 * centralizarlos aqui obligaria a tocar `@core` cada vez que se anade un nodo.
 * Lo que si es comun es el FORMATO —`ERR_` y UPPER_SNAKE_CASE— porque estos
 * valores se escriben a mano en el `catchErrors` de un esquema.
 */
export const ERR_NODE_CRASHED = 'ERR_NODE_CRASHED';
export const ERR_STRATEGY_NOT_FOUND = 'ERR_STRATEGY_NOT_FOUND';
export const ERR_NODE_HTTP_FAILURE = 'ERR_NODE_HTTP_FAILURE';

/** Detalle del fallo devuelto por una estrategia. */
export interface NodeErrorDetail {
  level: NodeErrorSeverity;
  /**
   * Identificador estable del fallo, en UPPER_SNAKE_CASE con prefijo `ERR_`.
   *
   * Obligatorio, y no opcional, porque es contra lo que compara el `catchErrors`
   * de `onErrorStep`: un fallo sin `code` seria inenrutable, y la ausencia solo
   * se descubriria el dia que hiciera falta la ruta, en produccion.
   *
   * Se separa de `message` porque tienen publicos distintos. El `message` lo lee
   * un humano y puede reescribirse en cualquier momento; el `code` lo lee un
   * esquema y es contrato: cambiarlo rompe en silencio todo `catchErrors` que lo
   * mencione.
   */
  code: string;
  message: string;
  /** Claves del contexto que se esperaban y no llegaron (`{{nodo.campo}}`). */
  missingFields?: string[];
  /** Traza completa; se volcara al `.log` fisico por el protocolo de resiliencia. */
  stackTrace?: string;
}

/**
 * Salida estandar de cualquier nodo.
 *
 * Un nodo NO lanza para senalar un fallo de negocio: devuelve `success: false`
 * con su `error`. Las excepciones quedan reservadas para lo imprevisto, que el
 * motor aisla y normaliza a este mismo contrato con nivel URGENTE.
 */
export interface NodeResult {
  success: boolean;
  /** Datos a escribir en el `outputNamespace` del nodo si `success` es true. */
  data?: Record<string, unknown>;
  /**
   * Fin ordenado del flujo pedido por el propio nodo.
   *
   * NO es un fallo: el nodo hizo su trabajo y concluyo que no hay nada que
   * procesar aguas abajo (un buzon sin correos nuevos, un filtro sin
   * coincidencias). El motor cierra la ejecucion en EXITOSO y no invoca los
   * pasos siguientes.
   *
   * Sin esta senal el caso solo tendria salidas malas: un `success: false`
   * dejaria el flujo PAUSADO varias veces por hora —el sondeo IMAP corre cada
   * minuto y un buzon vacio es lo NORMAL, no una incidencia—, y seguir adelante
   * romperia el nodo siguiente al interpolar un namespace sin las claves que
   * espera.
   *
   * Se declara aqui, en el contrato generico, y no como una constante que el
   * motor reconozca: asi cualquier nodo futuro puede detener el flujo sin que
   * `@core` tenga que importar nada de `@modules`.
   *
   * Solo se atiende cuando `success` es true; un nodo que falla ya tiene sus
   * propias rutas (`onErrorStep`, reintento, pausa).
   */
  halt?: { reason: string };
  error?: NodeErrorDetail;
}

/** Interfaz que implementan todas las estrategias de nodo. */
export interface INodeStrategy {
  /** Tipo con el que la factoria indexa esta estrategia. */
  readonly nodeType: NodeType;

  /**
   * Ejecuta el nodo contra el contexto acumulado.
   *
   * @param context Namespaces de los pasos previos. Solo debe leerse; el motor
   *                es quien escribe el resultado en el namespace del nodo.
   * @param params `params` declarados para este nodo en el `pipeline_schema`.
   */
  execute(
    context: StatePayloadContext,
    params: Record<string, unknown>,
  ): Promise<NodeResult>;
}
