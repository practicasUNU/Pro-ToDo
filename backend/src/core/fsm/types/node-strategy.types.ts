import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type { NodeType } from '@core/fsm/types/pipeline-schema.types';
import type { ClassConstructor } from 'class-transformer';

import type { PromptReference } from '@core/fsm/types/prompt-text-resolver.port';

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

/**
 * El flujo no ofrece aguas arriba ningun campo del tipo que el nodo necesita.
 *
 * Hermano de `ERR_MISSING_UPSTREAM_CONTEXT` y distinto de el: aquel dice "falta
 * el namespace X", este dice "no hay de donde sacar una URL". Solo lo emite la
 * regla 8 del validador de topologia, al GUARDAR; el motor no lo usa, porque en
 * ejecucion la pregunta relevante vuelve a ser si el valor concreto se resuelve.
 */
export const ERR_MISSING_UPSTREAM_FIELD_TYPE =
  'ERR_MISSING_UPSTREAM_FIELD_TYPE';

/**
 * El nodo se puede guardar pero no ejecutar: le faltan params por elegir.
 *
 * Lo emite `PipelineValidatorService` solo cuando se le pide validar para
 * ACTIVAR. Es la contrapartida de que el DTO de un nodo admita valores ausentes
 * al guardar, que es lo que permite que una plantilla de flujo exista.
 */
export const ERR_INCOMPLETE_NODE_PARAMS = 'ERR_INCOMPLETE_NODE_PARAMS';

/**
 * Tipo semantico de un campo del payload que un nodo deposita en su namespace.
 *
 * NO es el tipo de TypeScript, es para que sirve: `url` y `url[]` son los dos
 * que hoy consume el selector determinista del extractor web, que solo puede
 * ofrecer campos de los que salga una direccion. `text` y un numero son ambos
 * interpolables, pero ofrecer `character_count` como origen de una URL seria
 * exactamente el error de tipeo que el selector viene a impedir.
 */
export type NodeOutputFieldType =
  'url' | 'url[]' | 'text' | 'number' | 'boolean' | 'object';

/**
 * Campo del payload de un nodo, tal como se interpola.
 *
 * `name` va en `snake_case` porque asi viaja y asi se escribe en una plantilla
 * (`{{parsed_email.extracted_urls}}`); camelizarlo aqui mostraria al operador un
 * nombre que ninguna interpolacion puede resolver.
 */
export interface NodeOutputField {
  readonly name: string;
  readonly type: NodeOutputFieldType;
  /** Proposito del campo, para el `label` del selector. */
  readonly description?: string;
}

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
  /**
   * Causa raiz tecnica, separada del titular que es `message`.
   *
   * Los dos los lee un humano, pero en sitios distintos: `message` cabe en una
   * linea de toast o en el asunto de un correo, y esto es el parrafo que
   * explica QUE paso por debajo —el error del proveedor, cuantos intentos se
   * hicieron y contra que modelo—. Fundirlos obligaria a elegir entre un titular
   * ilegible y un detalle que no se cuenta en ninguna parte.
   */
  description?: string;
  /**
   * Datos estructurados del fallo, para quien decide y no para quien lee.
   *
   * La clave que el motor interpreta es `exhausted`: cuando vale `true`, la
   * estrategia declara que YA agoto su propio presupuesto de reintentos y
   * `canRetry` no vuelve a insistir. Sin ella, un `GRAVE` que ya consumio tres
   * intentos internos recibiria encima los del `retryPolicy` del nodo y los
   * intentos se multiplicarian, con una alerta por cada uno.
   *
   * Las demas claves habituales (`attempts`, `maxRetries`, `lastError`) son
   * informativas: viajan a `error_context` y de ahi al correo y al aviso.
   */
  metadata?: Record<string, unknown>;
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
  /**
   * Payload producido por el nodo. Se publica en su `outputNamespace`.
   *
   * La publicacion esta DESACOPLADA de `success`, y ese desacoplamiento es el
   * contrato:
   *
   * - `success: true`: se deposita siempre, con `{}` si el nodo no produjo
   *   nada. El namespace vacio no es un descuido: `findMissingNamespaces`
   *   cuenta la clave como presente, y es lo que permite que un nodo posterior
   *   lo declare en `getRequiredNamespaces` sin bloquearse.
   * - `success: false`: se deposita TAMBIEN, si el nodo alcanzo a producir
   *   algo. Un fallo desviado por `onErrorStep` no exime al nodo de su contrato
   *   de datos: la rama de recuperacion reincorpora el flujo a su curso, y los
   *   pasos de aguas abajo siguen interpolando el namespace que el esquema les
   *   prometio. El nodo que falla es ademas el UNICO que sabe que forma neutra
   *   satisface a sus consumidores —`WebScraperStrategy` hace lo mismo por su
   *   cuenta con `buildNeutralPayload`, emitiendo en blanco las cinco claves de
   *   sus `outputFields`.
   *
   * Un fallo CATASTROFICO es la excepcion y no publica: de un ejecutor que se
   * rompio no se sabe que dejo a medias, asi que el motor corta antes.
   *
   * Ademas, y no en lugar de lo anterior, un fallo desviado copia este mismo
   * payload en `error_context.partial_data`. Las dos vias coexisten a proposito
   * y no son redundantes: el namespace es el estado VIVO, que un nodo posterior
   * puede reescribir, mientras que `partial_data` es la instantanea del fallo
   * concreto, y es de ahi —y no del namespace— de donde la carta de
   * `SmtpAlertStrategy` saca lo que cuenta.
   *
   * `PARSER_PRE_IA` es el caso que lo motiva todo: ante un correo sin texto
   * aprovechable emite sus trece claves con el inventario real de adjuntos y el
   * `multimodal_reason`, que es lo que el nodo de respaldo necesita para decidir
   * si manda una alerta o invoca un modelo con vision. Tirarlo obligaria al
   * respaldo a volver a deducir del correo crudo lo que el parser ya dedujo.
   *
   * Sigue siendo OPCIONAL en un fallo: la mayoria de las estrategias no alcanzan
   * a producir nada antes de abortar. Entonces el namespace NO se crea —no se
   * escribe un `{}` que fingiria que el nodo corrio— y
   * `error_context.partial_data` recibe un objeto vacio.
   */
  data?: Record<string, unknown>;
  /**
   * Fin ordenado del flujo pedido por el propio nodo.
   *
   * NO es un fallo: el nodo hizo su trabajo y concluyo que no hay nada que
   * procesar aguas abajo (un buzon sin correos nuevos, un filtro sin
   * coincidencias). El motor cierra la ejecucion en OMITIDO —ni EXITOSO, que
   * reclamaria un trabajo que no se hizo, ni FALLIDO, que pediria que alguien
   * intervenga— y no invoca los pasos siguientes.
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
   * Campos que este nodo deposita en su `outputNamespace`.
   *
   * Es el INVENTARIO de lo que los nodos de aguas abajo pueden interpolar, y la
   * contrapartida exacta de `getRequiredNamespaces`: aquel declara lo que el
   * nodo consume, este lo que produce. Con los dos, el asistente puede componer
   * un selector cerrado de `{{namespace.campo}}` sin que ningun componente del
   * frontend tenga que replicar la forma de un payload.
   *
   * Se declara en la ESTRATEGIA y no en la tabla `nodos` porque es la estrategia
   * quien construye el payload: una fila de catalogo y un `*-payload.util.ts`
   * son dos fuentes que se desincronizan en cuanto alguien anade una clave, y la
   * que manda en ejecucion es siempre la segunda.
   *
   * PROPIEDAD CONSTANTE, a diferencia de `getRequiredNamespaces`: lo que un nodo
   * produce depende de su tipo y no de su configuracion. El parser devuelve las
   * mismas trece claves lea del namespace que lea.
   *
   * OPCIONAL: una estrategia que no lo declare simplemente no aporta opciones al
   * selector, igual que una sin `paramsSchema` no aporta validacion de params.
   */
  readonly outputFields?: readonly NodeOutputField[];

  /**
   * Tipos de campo que este nodo necesita poder APUNTAR aguas arriba.
   *
   * Contrapartida de `outputFields`: aquel declara lo que el nodo publica, este
   * la clase de dato sin el cual el nodo no es configurable. El extractor web
   * declara `['url', 'url[]']` porque su `targetUrl` solo puede referenciar un
   * campo del que salga una direccion.
   *
   * Lo consume la regla 8 del validador de topologia, que comprueba que algun
   * paso ANTERIOR publique al menos un campo de alguno de estos tipos. Esa
   * comprobacion no puede vivir en el DTO del nodo: `class-validator` valida un
   * nodo AISLADO y no tiene forma de saber quien va delante.
   *
   * Es lo que permite que `targetUrl` sea opcional al guardar sin perder la
   * garantia topologica. Antes esa garantia la sostenia un fallback dentro de
   * `getRequiredNamespaces` que, a falta de configuracion, SUPONIA `parsed_email`
   * y acusaba al operador de un namespace que su esquema nunca cito. Preguntar
   * por el tipo de campo sustituye la suposicion por un hecho.
   *
   * OPCIONAL: la mayoria de los nodos consume el contexto entero y no depende de
   * ningun campo en particular.
   */
  readonly requiredUpstreamFieldTypes?: readonly NodeOutputFieldType[];

  /**
   * Variante de `requiredUpstreamFieldTypes` que DEPENDE de la configuracion.
   *
   * Existe porque para algunos nodos la exigencia dejo de ser una propiedad del
   * TIPO de nodo y paso a ser una propiedad de ESTE nodo concreto. El extractor
   * web es el caso: con `skipIfEmpty` activo declara un fallback neutro
   * explicito, de modo que un flujo de contingencia —un OCR que no publica
   * ninguna URL aguas arriba— es una topologia legitima y no un esquema mal
   * compuesto. Preguntarle a la propiedad estatica no permitiria distinguirlos.
   *
   * La consume el mismo resolver de la regla 8, que la PREFIERE sobre la
   * propiedad cuando existe. Una estrategia cuya exigencia no varie no lo
   * declara y sigue respondiendo con la propiedad.
   */
  readonly getRequiredUpstreamFieldTypes?: (
    params: Record<string, unknown>,
  ) => readonly NodeOutputFieldType[];

  /**
   * `params` que faltan para que el nodo pueda EJECUTARSE, no solo guardarse.
   *
   * Existe porque guardar y activar son dos exigencias distintas, y confundirlas
   * tenia un coste concreto: una PLANTILLA de flujo es una topologia sin
   * operativa —sus `params` van vacios a proposito, y el valor concreto se elige
   * despues, en el asistente—, asi que exigir el campo en el DTO hacia que
   * ninguna plantilla pudiera contener un EXTRACTOR_WEB.
   *
   * El DTO valida entonces la FORMA de lo que haya (`@IsOptional` + `@Matches`:
   * si viene, debe ser una interpolacion) y este metodo responde a la otra
   * pregunta, la que solo importa al activar: "esta completo". `assertActivatable`
   * es quien lo consulta.
   *
   * @returns Nombres de los params ausentes o vacios. Vacio si el nodo puede correr.
   */
  readonly getIncompleteParams?: (
    params: Record<string, unknown>,
  ) => readonly string[];

  /**
   * Codigos de fallo que este nodo NUNCA emitira con estos `params`.
   *
   * Existe porque hay nodos cuyo repertorio de fallos depende de su
   * configuracion, y una ruta de error declarada contra un codigo que el nodo no
   * puede producir es un nodo de respaldo que jamas corre. El sintoma es mudo:
   * no hay excepcion, no hay traza, simplemente el correo que debia desviarse
   * sigue de largo. `PARSER_PRE_IA` es el caso de hoy —solo emite
   * `ERR_PARSER_UNEXTRACTABLE_MEDIA` si `failOnUnextractableMedia` esta puesto—
   * y lo que este metodo permite es rechazar esa combinacion al GUARDAR.
   *
   * Es el negativo de la pregunta que la estrategia ya sabe responder: no "que
   * puedo fallar", que seria un inventario que nadie mantiene al dia, sino "que
   * he apagado", que es una sola condicion junto al `param` que la gobierna.
   *
   * PURO Y SINCRONO, como `getRequiredNamespaces`: solo mira `params`. Lo
   * consulta la regla 10 del validador de topologia, que es una funcion pura y
   * recibe el resolutor por parametro para no depender del contenedor de Nest.
   *
   * Vive AQUI y no como una lista en `@core` por la misma razon que los codigos
   * de cada estrategia viven junto a ella: el nucleo no debe conocerlos, y
   * centralizarlos obligaria a tocar `@core` cada vez que se anade un nodo.
   *
   * OPCIONAL: la mayoria de los nodos emite siempre el mismo repertorio.
   */
  readonly getUnreachableErrorCodes?: (
    params: Record<string, unknown>,
  ) => readonly string[];

  /**
   * Prompts GUARDADOS que este nodo cita en sus `params`.
   *
   * Existe porque `getRequiredNamespaces` no puede responder por ellos: es puro
   * y sincrono por contrato, y el texto de un prompt vive en base de datos. Sin
   * esta declaracion, un nodo que resuelve su instruccion por `templatePromptId`
   * o `promptCode` parece no depender de nada, y un `{{scraped_web.x}}` escrito
   * dentro de ese prompt se cuela hasta la ejecucion.
   *
   * Lo que se declara es la REFERENCIA, no el texto ni los namespaces: resolverla
   * es I/O y la hace `PipelineValidatorService` antes de validar la topologia,
   * de una sola vez para todo el esquema.
   *
   * Vive aqui, en el contrato generico, para que `@core` no tenga que conocer
   * los nombres de los params de un nodo concreto —no sabe lo que es un
   * `templatePromptId`, igual que no sabe lo que es un `targetUrl`— y para que
   * cualquier nodo futuro que resuelva instrucciones guardadas quede cubierto
   * sin tocar el validador.
   *
   * OPCIONAL: solo los nodos que hablan con un modelo citan prompts.
   */
  readonly getPromptReferences?: (
    params: Record<string, unknown>,
  ) => readonly PromptReference[];

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
