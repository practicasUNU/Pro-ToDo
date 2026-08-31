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

/** Detalle del fallo devuelto por una estrategia. */
export interface NodeErrorDetail {
  level: NodeErrorSeverity;
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
