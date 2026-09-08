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

/** Versionado SemVer estricto del esquema (`MAJOR.MINOR.PATCH`). */
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Tipos de nodo que una estrategia (`INodeStrategy`) puede declarar.
 *
 * Es un enum y no un union type porque `@IsEnum()` de class-validator necesita
 * un objeto disponible en runtime. Los valores replican el `codigo` de la tabla
 * `tipos_nodo` (ver `db/migrations/005-tipos-nodo-fsm.sql`).
 */
export enum NodeType {
  TRIGGER_IMAP = 'TRIGGER_IMAP',
  PARSER_PRE_IA = 'PARSER_PRE_IA',
  EXTRACTOR_WEB = 'EXTRACTOR_WEB',
  PROCESADOR_IA = 'PROCESADOR_IA',
  ESCUDO_POST_IA = 'ESCUDO_POST_IA',
  MAPEADOR_PLANTILLA = 'MAPEADOR_PLANTILLA',
  DESTINO_HTTP = 'DESTINO_HTTP',
}

/** Politica de reintentos de un nodo ante un `NodeResult` fallido. */
export interface RetryPolicy {
  /** Reintentos adicionales tras el primer intento. Entre 0 y `MAX_RETRY_ATTEMPTS`. */
  maxRetries: number;
  /** Espera base en milisegundos antes del primer reintento. */
  backoffMs?: number;
  /** Multiplicador aplicado a `backoffMs` en cada reintento (backoff exponencial). */
  backoffFactor?: number;
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
  /** Nodo al que saltar ante un fallo, o `null` para detener la ejecucion. */
  onErrorStep: string | null;
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
}
