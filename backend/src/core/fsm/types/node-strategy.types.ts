import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type { NodeType } from '@core/fsm/types/pipeline-schema.types';
import type { ClassConstructor } from 'class-transformer';

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

/**
 * El nodo declaro necesitar namespaces que el contexto acumulado no trae.
 *
 * Es del MOTOR y no de una estrategia porque lo emite la guarda de `runNode`,
 * antes de invocar a nadie: cuando se decide, todavia no hay estrategia que
 * pueda haberlo producido.
 */
export const ERR_MISSING_UPSTREAM_CONTEXT = 'ERR_MISSING_UPSTREAM_CONTEXT';

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
   * Namespaces del contexto sin los cuales este nodo no puede operar.
   *
   * Es un METODO y no una propiedad constante porque la dependencia de casi
   * todos los nodos se deduce de SU CONFIGURACION, no de su tipo: el parser lee
   * del `sourceNamespace` que declare el esquema, y el extractor web de la raiz
   * de la plantilla de `targetUrl`. Una constante de clase acertaria solo con
   * los valores por defecto, y rechazaria como invalido un nodo legitimamente
   * reconfigurado —que es exactamente el fallo que esta guarda existe para
   * evitar, cometido por la propia guarda.
   *
   * PURO Y SINCRONO: solo mira `params`. Esa restriccion es deliberada y tiene
   * consecuencias: el nodo MAPEADOR_PLANTILLA no puede implementarlo, porque
   * sus variables requeridas viven en la tabla `plantillas_html` y derivarlas
   * exigiria una consulta. Volver el metodo asincrono por un solo nodo obligaria
   * a los otros cuatro a pagar una promesa por nada, y ese nodo ya diagnostica
   * el problema mejor por su cuenta (ver su TSDoc).
   *
   * OPCIONAL: un disparador es el primero del grafo y no tiene nada aguas
   * arriba. El motor comprueba su existencia antes de llamarlo.
   *
   * Lo que se declara son NOMBRES DE NAMESPACE, no rutas: la pregunta que
   * responde esta capa es "corrio el nodo que produce esto", no "trae el campo
   * que espero". Lo segundo es competencia de la estrategia, que es la unica que
   * sabe que campos necesita.
   */
  readonly getRequiredNamespaces?: (
    params: Record<string, unknown>,
  ) => readonly string[];

  /**
   * DTO con el que se validan los `params` de este nodo AL GUARDAR el esquema.
   *
   * Hasta ahora cada estrategia validaba los suyos solo dentro de `execute`, de
   * modo que un nodo mal configurado se guardaba sin protestar y el operador se
   * enteraba con el flujo ya PAUSADO, horas despues y en produccion. Declarar
   * aqui el DTO adelanta ese rechazo al 400 de la peticion que lo guarda.
   *
   * Se declara la CLASE y no un metodo validador a proposito: asi la
   * instanciacion, el aplanado del arbol de `ValidationError` y el prefijo
   * `nodes.<id>.params.` los hace UNA sola vez `PipelineValidatorService`, que
   * ya tiene esa maquinaria montada para el propio `PipelineNodeConfigDto`. Un
   * metodo por estrategia la duplicaria cinco veces.
   *
   * OPCIONAL, y hoy solo lo declara el extractor web. Enchufar las otras cuatro
   * es una linea cada una, pero endurece tambien la REVALIDACION que hace
   * `assertActivatable`: un flujo heredado podria quedarse sin poder activarse
   * por un motivo ajeno al cambio que lo introdujo, asi que cada una merece su
   * propia pasada de regresion.
   */
  readonly paramsSchema?: ClassConstructor<object>;

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
