/**
 * Contratos del `pipeline_schema`: la descripcion declarativa del grafo que el
 * `FsmEngineService` recorre paso a paso. Se persiste en la columna JSONB
 * `flujos.configuracion_pipeline` y es la unica fuente de verdad sobre que nodo
 * viene despues de cual, donde escribe cada uno su resultado y como se reintenta
 * ante un fallo.
 *
 * Estas interfaces describen la forma del JSON ya validado. La validacion en si
 * vive en `@core/fsm/dto/pipeline-schema.dto` (forma y tipos) y en
 * `@core/fsm/validators/pipeline-topology.validator` (integridad del grafo).
 */

/** Numero maximo de reintentos que un nodo puede declarar en su `RetryPolicy`. */
export const MAX_RETRY_ATTEMPTS = 5;

/**
 * Formato obligatorio de `outputNamespace`: snake_case alfanumerico.
 *
 * El namespace acaba siendo una clave del `StatePayloadContext` y se interpola
 * en plantillas como `{{raw_email.campo}}`, cuya expresion de sustitucion
 * (ver `architecture-patterns.md` §3) solo reconoce `[a-zA-Z0-9_]`. Restringirlo
 * aqui evita namespaces que el motor nunca podria resolver.
 */
export const OUTPUT_NAMESPACE_PATTERN = /^[a-z0-9_]+$/;

/**
 * Namespaces que un nodo puede declarar como `outputNamespace`.
 *
 * Es una lista CERRADA y no un formato libre. El namespace acaba siendo la raiz
 * de `{{ns.campo}}` en las plantillas HTML, y el gestor de plantillas rechaza
 * cualquier raiz desconocida: admitir aqui lo que alli se rechaza solo traslada
 * el fallo del asistente —donde el operador aun puede corregirlo— al guardado de
 * la plantilla, donde ya no sabe que lo causo.
 *
 * Vive en `@core` y no junto a la lista blanca de plantillas porque el validador
 * de topologia la necesita, y el nucleo no puede importar de `@modules`.
 * `ALLOWED_NAMESPACES` (`templates.service.ts`) se deriva de esta lista
 * anadiendo `_assets`, que no lo escribe ningun nodo.
 */
export const NODE_OUTPUT_NAMESPACES = [
  'raw_email',
  'cron_trigger',
  'parsed_email',
  'scraped_web',
  'llm_response',
  'validated_drupal_json',
  'rendered_html',
  'http_result',
  'smtp_result',
  'ocr_result',
] as const;

/**
 * Namespace reservado con los metadatos del fallo que provoco un desvio.
 *
 * Lo siembra el motor JUSTO antes de saltar por `onErrorStep`, y es lo unico
 * que distingue una rama de recuperacion util de una ciega: sin el, el nodo de
 * respaldo se entera de que le toca correr pero no de por que. Un nodo de
 * alerta no podria decir que fallo, y uno de IA no sabria que se espera de el.
 *
 * `snake_case` como todos sus hermanos (`raw_email`, `parsed_email`,
 * `trigger`): el nombre acaba siendo la raiz de un `{{ns.campo}}`, y
 * `OUTPUT_NAMESPACE_PATTERN` solo admite `[a-z0-9_]`.
 *
 * NO figura en `NODE_OUTPUT_NAMESPACES` porque ningun nodo lo escribe. Se
 * declara en `ENGINE_PROVIDED_NAMESPACES` del validador de topologia, igual que
 * `trigger`, para que un nodo de respaldo pueda interpolarlo sin que el
 * validador exija un productor que no existe.
 */
export const ERROR_CONTEXT_NAMESPACE = 'error_context';

/** Busqueda O(1) para el validador de topologia. */
export const NODE_OUTPUT_NAMESPACE_SET: ReadonlySet<string> = new Set(
  NODE_OUTPUT_NAMESPACES,
);

/** Versionado SemVer estricto del esquema (`MAJOR.MINOR.PATCH`). */
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Tipos de nodo que una estrategia (`INodeStrategy`) puede declarar.
 *
 * Es un enum y no un union type porque `@IsEnum()` de class-validator necesita
 * un objeto disponible en runtime. Los valores replican el `codigo` de la tabla
 * `nodos`, el catalogo estatico de tipos (ver `db/migrations/011-catalogo-nodos.sql`;
 * la tabla se llamaba `tipos_nodo` hasta esa migracion).
 *
 * El catalogo tiene ONCE filas y este enum declara diez: `DESTINO_ACENS` sigue
 * sin estrategia, asi que no es expresable en un `pipeline_schema`.
 * `GET /api/nodos` lo devuelve marcado con `implemented: false` para que el
 * selector del frontend lo deshabilite.
 *
 * `DESTINO_SMTP` (migracion 021) es la alerta por correo que da destino a las
 * rutas de `onErrorStep`. Lleva el prefijo `DESTINO_` y la categoria `DESTINO`
 * porque el criterio de esa familia es escribir FUERA del sistema, que es lo que
 * hace, aunque su contenido sea un aviso y no una publicacion.
 *
 * `PROCESADOR_OCR` (migracion 022) transcribe los adjuntos de un correo que no
 * trae texto aprovechable. Es un tipo APARTE de `PROCESADOR_IA` y no un modo
 * suyo: transcribir una imagen y redactar una noticia son trabajos distintos,
 * con modelo, prompt y presupuesto distintos, y fundirlos obligaba a un solo
 * juego de `params` para los dos. Tenerlo aparte le da ademas su propio
 * `ocr_result`, sin el cual un segundo nodo de IA chocaria con el primero en
 * `llm_response` (regla 5 del validador).
 */
export enum NodeType {
  TRIGGER_IMAP = 'TRIGGER_IMAP',
  TRIGGER_CRON = 'TRIGGER_CRON',
  PARSER_PRE_IA = 'PARSER_PRE_IA',
  EXTRACTOR_WEB = 'EXTRACTOR_WEB',
  PROCESADOR_IA = 'PROCESADOR_IA',
  ESCUDO_POST_IA = 'ESCUDO_POST_IA',
  MAPEADOR_PLANTILLA = 'MAPEADOR_PLANTILLA',
  DESTINO_HTTP = 'DESTINO_HTTP',
  DESTINO_SMTP = 'DESTINO_SMTP',
  PROCESADOR_OCR = 'PROCESADOR_OCR',
}

/**
 * Tipos de nodo que pueden abrir un flujo (Entry Point).
 *
 * Se declara aqui y NO se deriva de `NodeCategory`: esa categoria es la columna
 * `enum_categoria` y vive en `@modules/nodes`, de donde el nucleo no puede
 * importar. La lista es cerrada, y anadir un disparador nuevo obliga a tocar
 * tambien el enum `NodeType` de este mismo fichero, asi que no se pueden
 * desincronizar en silencio.
 */
export const TRIGGER_NODE_TYPES: ReadonlySet<NodeType> = new Set([
  NodeType.TRIGGER_IMAP,
  NodeType.TRIGGER_CRON,
]);

/** Politica de reintentos de un nodo ante un `NodeResult` fallido. */
export interface RetryPolicy {
  /** Reintentos adicionales tras el primer intento. Entre 0 y `MAX_RETRY_ATTEMPTS`. */
  maxRetries: number;
  /** Espera base en milisegundos antes del primer reintento. */
  backoffMs?: number;
  /** Multiplicador aplicado a `backoffMs` en cada reintento (backoff exponencial). */
  backoffFactor?: number;
}

/**
 * Politica de ejecucion del flujo COMPLETO.
 *
 * Es el contrapunto de `RetryPolicy`, que gobierna un nodo suelto: esta decide
 * que pasa con el flujo entero una vez la ejecucion termina. Opcional en el
 * esquema; sin ella, el comportamiento es el de siempre.
 */
export interface PipelineExecutionPolicy {
  /**
   * Desactiva el flujo (`flujos.activo = false`) tras la primera ejecucion que
   * recorra el grafo entero con exito.
   *
   * NO cuenta como exito una ejecucion detenida por `halt`. Ahi el disparador
   * concluyo que no habia NADA que procesar —un buzon sin correos nuevos— y la
   * ejecucion cierra en EXITOSO sin haber hecho ningun trabajo: tratarlo como
   * "primer exito" apagaria el flujo en su primer sondeo, antes de haber
   * procesado un solo correo. Quien distingue los dos casos es
   * `FsmExecution.haltReason`.
   *
   * Solo se evalua en el despacho automatico (`runAutomaticWorkflow`). El
   * despacho manual de pruebas queda fuera a proposito: el operador usa ese
   * endpoint para iterar sobre una plantilla, y cada prueba exitosa le
   * obligaria a reactivar el flujo a mano.
   */
  readonly stopOnFirstSuccess?: boolean;
}

/**
 * Ruta de recuperacion que solo atrapa los codigos de error declarados.
 *
 * Es lo que distingue una ruta util de un `onErrorStep` clasico: aquel desvia
 * ante CUALQUIER fallo, de modo que un nodo de aviso disenado para un timeout
 * acabaria tragandose tambien un error de configuracion, y el flujo seguiria
 * adelante sobre un problema que nadie ha visto.
 */
export interface SelectiveErrorFallback {
  /** Nodo al que saltar. Debe existir en el mapa `nodes`. */
  readonly targetNode: string;
  /** Codigos que esta ruta atrapa. Vacio equivale a no atrapar nada. */
  readonly catchErrors: readonly string[];
  /**
   * Descripcion que sustituye al mensaje del fallo al registrar la traza.
   *
   * Existe porque el mensaje de una estrategia esta escrito para quien depura
   * —"Fallo la lectura del buzon X en host Y: ETIMEDOUT"— y quien lee la
   * trazabilidad suele necesitar otra cosa: por que importa ese fallo en ESTE
   * flujo. No sustituye al `code`, que sigue siendo lo que identifica el fallo.
   */
  readonly customMessage?: string;
}

/** Configuracion de un nodo dentro del grafo del pipeline. */
export interface PipelineNodeConfig {
  /** Identificador del nodo. Debe coincidir con su clave en `PipelineSchema.nodes`. */
  nodeId: string;
  /** Tipo de estrategia que resolvera la `NodeStrategyFactory`. */
  nodeType: NodeType;
  /** Namespace bajo el que este nodo escribe su resultado en el contexto. Unico en todo el pipeline. */
  outputNamespace: string;
  /** Siguiente nodo del camino activo, o `null` si es el nodo terminal. */
  nextStep: string | null;
  /**
   * Ruta de recuperacion ante un fallo, o `null` para detener la ejecucion.
   *
   * Admite DOS formas, y la clave conserva su nombre historico a proposito: hay
   * esquemas ya persistidos en `configuracion_pipeline` con la forma
   * `string | null`, y `PipelineValidatorService` valida con
   * `forbidNonWhitelisted`, de modo que renombrar el campo habria dejado esas
   * filas devolviendo un 400 en cada despacho.
   *
   * - `string`: respaldo INCONDICIONAL. Es la semantica de siempre.
   * - `SelectiveErrorFallback`: desvia SOLO si el `code` del fallo figura en
   *   `catchErrors`. Ante cualquier otro codigo el flujo se detiene como si no
   *   hubiera ruta, que es justo lo que hace util declararla.
   *
   * Quien resuelve la forma es `resolveErrorRoute` (`pipeline-topology.util`);
   * ningun consumidor debe inspeccionar la union por su cuenta.
   */
  onErrorStep: string | SelectiveErrorFallback | null;
  /** Politica de reintentos. Si se omite, el nodo no reintenta. */
  retryPolicy?: RetryPolicy;
  /** Parametros propios del tipo de nodo; cada estrategia valida los suyos. */
  params: Record<string, unknown>;
}

/** Esquema completo del pipeline de un flujo. */
export interface PipelineSchema {
  /** Identificador del flujo al que pertenece este esquema. */
  flowId: string;
  /** Nombre legible del pipeline. */
  name: string;
  /** Version del esquema en formato SemVer (ej. `1.0.0`). */
  version: string;
  /** Clave de `nodes` por la que arranca el camino activo. */
  entrypoint: string;
  /** Mapa de nodos indexado por `nodeId`. */
  nodes: Record<string, PipelineNodeConfig>;
  /** Politica del flujo completo. Si se omite, la ejecucion no altera el flujo. */
  executionPolicy?: PipelineExecutionPolicy;
}
