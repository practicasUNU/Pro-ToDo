// Replica exacta de los contratos del motor FSM (NestJS). Cualquier cambio en
// `@core/fsm/types/pipeline-schema.types.ts` debe reflejarse aqui.

/**
 * Tipos de nodo admitidos por el pipeline. Enum real (no `type`) porque se
 * recorre en tiempo de ejecucion para poblar selectores y el registro de
 * componentes de configuracion.
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

/** Etiquetas legibles para los selectores; el enum viaja crudo al backend. */
export const NODE_TYPE_LABELS: Record<NodeType, string> = {
  [NodeType.TRIGGER_IMAP]: 'Disparador IMAP',
  [NodeType.PARSER_PRE_IA]: 'Parser previo a IA',
  [NodeType.EXTRACTOR_WEB]: 'Extractor web',
  [NodeType.PROCESADOR_IA]: 'Procesador IA',
  [NodeType.ESCUDO_POST_IA]: 'Escudo posterior a IA',
  [NodeType.MAPEADOR_PLANTILLA]: 'Mapeador de plantilla',
  [NodeType.DESTINO_HTTP]: 'Destino HTTP',
};

/**
 * Namespaces que el `outputNamespace` de un nodo puede tomar.
 *
 * `OUTPUT_NAMESPACE_PATTERN` del backend restringe el formato a minusculas,
 * digitos y guion bajo: un namespace con guiones jamas podria resolverse desde
 * una plantilla, y por eso el DTO lo rechaza de entrada.
 */
export const OUTPUT_NAMESPACE_PATTERN = /^[a-z0-9_]+$/;
