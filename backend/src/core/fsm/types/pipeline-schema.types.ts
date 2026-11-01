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
  'pause_context',
  'http_generic_response',
  'acens_result',
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

/**
 * Copia numerada de un namespace base: `ocr_result_2`, `smtp_result_3`.
 *
 * EXISTE PARA QUE UN FLUJO PUEDA REPETIR UN TIPO DE NODO. La regla 5 prohibe
 * que dos nodos escriban el mismo namespace —y debe seguir prohibiendolo: el
 * segundo pisaria los campos del primero en el contexto—, pero hasta ahora la
 * lista cerrada no ofrecia ninguna alternativa legal, de modo que un flujo con
 * dos OCR se rechazaba al guardar sin que el operador tuviera forma de
 * arreglarlo desde el selector.
 *
 * Arranca en 2 y no en 1 porque la copia 1 es la base: admitir `ocr_result_1`
 * crearia dos nombres para el mismo nodo y el operador no sabria cual eligio al
 * releer el flujo. Dos digitos como techo; `MaxLength(50)` del DTO ya acota el
 * total.
 *
 * El sufijo va con guion bajo, como `deriveNodeId` hace con los identificadores
 * (`destino_smtp_2`), y no pegado: el nombre acaba siendo la raiz de un
 * `{{ns.campo}}` y `ocr_result2` se lee como un namespace distinto en vez de
 * como la segunda copia de uno conocido.
 */
export const NODE_OUTPUT_NAMESPACE_COPY_PATTERN = /^(.+)_([2-9]|[1-9][0-9])$/;

/**
 * Namespace base del que una clave es copia; ella misma si no lo es.
 *
 * Lo necesitan los catalogos de variables: los campos que publica
 * `ocr_result_2` son los que declara la estrategia para `ocr_result`.
 */
export const baseOutputNamespace = (namespace: string): string => {
  const match = NODE_OUTPUT_NAMESPACE_COPY_PATTERN.exec(namespace);

  return match?.[1] !== undefined && NODE_OUTPUT_NAMESPACE_SET.has(match[1])
    ? match[1]
    : namespace;
};

/**
 * El namespace es uno de la lista cerrada, o una copia numerada de uno de ella.
 *
 * Sustituye a `NODE_OUTPUT_NAMESPACE_SET.has` en los DOS sitios que deciden si
 * una raiz es legal: el validador de topologia y el gestor de plantillas HTML.
 * Si solo se relajase el primero, el asistente aceptaria `ocr_result_2` y el
 * editor de plantillas rechazaria `{{ocr_result_2.campo}}` despues, que es
 * exactamente el reparto de culpas que la lista cerrada existe para evitar.
 */
export const isAllowedOutputNamespace = (namespace: string): boolean =>
  NODE_OUTPUT_NAMESPACE_SET.has(baseOutputNamespace(namespace));

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
 * El enum declara las TRECE filas del catalogo. `DESTINO_ACENS` (migracion 066)
 * fue la ultima en ganar estrategia: entrega a la API de Acens, cuya URL base y
 * clave viven en el entorno (`AcensApiConfig`), no en los `params` del nodo.
 *
 * `DESTINO_HTTP_GENERICO` (migracion 056, MOD-03) es el conector de salida a
 * cualquier API REST publica, autenticado con la boveda de credenciales.
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
 *
 * `PAUSA_FLOW` detiene el flujo A PROPOSITO, no por fallo. Es de categoria
 * CONTROL y no DESTINO: no entrega nada fuera del sistema y conserva su
 * `nextStep`, que es justo donde queda el cursor para que un operador reanude.
 * Su `pause_context` documenta cuando y por que se detuvo; sin namespace propio
 * la trazabilidad no podria explicar una ejecucion que termina a medias sin
 * ningun error asociado.
 */
export enum NodeType {
  TRIGGER_IMAP = 'TRIGGER_IMAP',
  TRIGGER_CRON = 'TRIGGER_CRON',
  PARSER_PRE_IA = 'PARSER_PRE_IA',
  EXTRACTOR_WEB = 'EXTRACTOR_WEB',
  PROCESADOR_IA = 'PROCESADOR_IA',
  ESCUDO_POST_IA = 'ESCUDO_POST_IA',
  MAPEADOR_PLANTILLA = 'MAPEADOR_PLANTILLA',
  DESTINO_DRUPAL = 'DESTINO_DRUPAL',
  DESTINO_SMTP = 'DESTINO_SMTP',
  PROCESADOR_OCR = 'PROCESADOR_OCR',
  PAUSA_FLOW = 'PAUSA_FLOW',
  DESTINO_HTTP_GENERICO = 'DESTINO_HTTP_GENERICO',
  DESTINO_ACENS = 'DESTINO_ACENS',
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

/**
 * Tipos de nodo que CIERRAN un flujo: entregan el resultado fuera del sistema.
 *
 * Se declara a mano por el mismo motivo que `TRIGGER_NODE_TYPES`: la categoria
 * autentica es la columna `enum_categoria` de la tabla `nodos`, que vive en
 * `@modules/nodes` y de la que el nucleo no puede depender. Anadir un destino
 * obliga a tocar el enum `NodeType` de este mismo fichero, asi que las dos
 * listas no pueden desincronizarse en silencio.
 */
export const DESTINO_NODE_TYPES: ReadonlySet<NodeType> = new Set([
  NodeType.DESTINO_DRUPAL,
  NodeType.DESTINO_SMTP,
  NodeType.DESTINO_HTTP_GENERICO,
  NodeType.DESTINO_ACENS,
]);

/**
 * Tipos de nodo de categoria PROCESAMIENTO: los que ingieren o transforman el
 * contenido antes de entregarlo (columna `enum_categoria` de `nodos`).
 *
 * Declarado a mano por el mismo motivo que `TRIGGER_NODE_TYPES`. Lo usa la
 * regla 13 del validador: un destino tiene que llegar DESPUES de al menos uno
 * de estos, o entregaria el disparo en crudo. Los de CONTROL (`ESCUDO_POST_IA`,
 * `PAUSA_FLOW`) no cuentan: vigilan o detienen, pero no producen contenido.
 */
export const PROCESSING_NODE_TYPES: ReadonlySet<NodeType> = new Set([
  NodeType.PARSER_PRE_IA,
  NodeType.EXTRACTOR_WEB,
  NodeType.PROCESADOR_IA,
  NodeType.PROCESADOR_OCR,
  NodeType.MAPEADOR_PLANTILLA,
]);

/**
 * Nombre legible de cada tipo, para los mensajes que llegan al operador.
 *
 * Replica EXACTA de `NODE_TYPE_LABELS` del frontend (`types/pipeline.ts`): el
 * error de duplicado lo puede emitir cualquiera de las dos capas, y el texto
 * tiene que ser el mismo para que el operador no vea dos nombres del mismo nodo.
 */
export const NODE_TYPE_LABELS: Readonly<Record<NodeType, string>> = {
  [NodeType.TRIGGER_IMAP]: 'Disparador IMAP',
  [NodeType.TRIGGER_CRON]: 'Disparador Cron',
  [NodeType.PARSER_PRE_IA]: 'Parser de Correo',
  [NodeType.EXTRACTOR_WEB]: 'Extractor web',
  [NodeType.PROCESADOR_IA]: 'Procesador IA',
  [NodeType.ESCUDO_POST_IA]: 'Escudo posterior a IA',
  [NodeType.MAPEADOR_PLANTILLA]: 'Mapeador de plantilla',
  [NodeType.DESTINO_DRUPAL]: 'Destino Drupal',
  [NodeType.DESTINO_SMTP]: 'Alerta por correo',
  [NodeType.PROCESADOR_OCR]: 'Procesador OCR',
  [NodeType.PAUSA_FLOW]: 'Pausa de flujo',
  [NodeType.DESTINO_HTTP_GENERICO]: 'Destino HTTP genérico',
  [NodeType.DESTINO_ACENS]: 'Destino Acens',
};

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
   * ejecucion cierra en OMITIDO sin haber hecho ningun trabajo: tratarlo como
   * "primer exito" apagaria el flujo en su primer sondeo, antes de haber
   * procesado un solo correo. Los dos casos se distinguen por el estado y,
   * dentro del proceso que despacha, tambien por `FsmExecution.haltReason`.
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
