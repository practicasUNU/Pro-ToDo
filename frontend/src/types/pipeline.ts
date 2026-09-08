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

/**
 * Un paso del pipeline tal como lo devuelve `GET /api/workflows`.
 *
 * Replica de `PipelineStepDto` del backend, que es una proyeccion PARCIAL del
 * nodo: no trae `params` —ahi viven el host y la clave de entorno del buzon, que
 * no deben llegar al navegador— ni los punteros del grafo, porque el arreglo ya
 * llega en orden de ejecucion.
 */
export interface PipelineStep {
  readonly nodeId: string;
  readonly nodeType: NodeType;
  readonly outputNamespace: string;
}

/** Flujo seleccionable como plantilla en la Fase 0 del asistente. */
export interface PipelineSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly active: boolean;
  /** Pasos EN ORDEN DE EJECUCION, ya resueltos por el backend. */
  readonly topology: PipelineStep[];
}

/**
 * Paso del asistente: un `PipelineStep` con su etiqueta legible ya resuelta.
 *
 * `name` NO viaja desde el backend: `NODE_TYPE_LABELS` ya vive en este archivo,
 * asi que mandarlo por la red seria duplicar en dos idiomas la misma tabla de
 * traduccion y arriesgarse a que divergan. Lo deriva `toWizardStep`.
 */
export interface WizardStep extends PipelineStep {
  readonly name: string;
}

/** Enriquece un paso del backend con su etiqueta legible. */
export const toWizardStep = (step: PipelineStep): WizardStep => ({
  ...step,
  name: NODE_TYPE_LABELS[step.nodeType],
});

/**
 * Cuerpo de `POST /api/wizard/check-imap`.
 *
 * Replica de `ImapTriggerConfigDto` del backend, sin `outputNamespace` ni
 * `markAsRead`: la comprobacion solo necesita los datos de conexion.
 *
 * NO existe campo `password`, y no es una omision: el backend valida con
 * `forbidNonWhitelisted`, asi que un cuerpo que lo incluya se rechaza con un
 * 400. El secreto vive en el `.env` del servidor y aqui solo viaja el NOMBRE de
 * la variable que lo contiene (`security-and-scope.md` §0.1).
 */
export interface CheckImapPayload {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly passwordEnvKey: string;
  readonly mailbox: string;
  readonly pollIntervalMs: number;
}

/** Severidad de un fallo, con la misma escala que el motor FSM. */
export type NodeErrorSeverity = 'LEVE' | 'GRAVE' | 'URGENTE';

/**
 * Resultado de la comprobacion de conectividad.
 *
 * `success: false` llega con status 200: el diagnostico del servidor de correo
 * es parte de la respuesta, no un fallo de la peticion. No incluye `stackTrace`
 * porque el backend no lo expone (revelaria rutas del servidor).
 */
export interface CheckImapResult {
  readonly success: boolean;
  readonly message?: string;
  readonly error?: {
    readonly level: NodeErrorSeverity;
    readonly message: string;
  };
}

/**
 * Cuerpo de `POST /api/workflows`.
 *
 * `pipelineSchema` va sin tipar en profundidad a proposito: lo ensambla el
 * asistente a partir de la `config` de cada store de nodo, y el backend lo valida
 * con `PipelineValidatorService`. Replicar aqui el grafo completo con tipos
 * estrictos obligaria a mantener dos definiciones sincronizadas del mismo
 * contrato para no ganar nada: el error de forma llega igual como 400.
 *
 * No incluye `createdById`: la autoria la toma el backend del token JWT.
 */
export interface CreateWorkflowPayload {
  readonly name: string;
  readonly description?: string;
  readonly pipelineSchema: AssembledPipelineSchema;
  readonly active?: boolean;
}

/** Nodo del `pipeline_schema` tal como lo ensambla el asistente. */
export interface AssembledPipelineNode {
  readonly nodeId: string;
  readonly nodeType: NodeType;
  readonly outputNamespace: string;
  readonly nextStep: string | null;
  readonly onErrorStep: string | null;
  readonly params: Record<string, unknown>;
}

/** Grafo completo que el asistente envia al backend. */
export interface AssembledPipelineSchema {
  readonly flowId: string;
  readonly name: string;
  readonly version: string;
  readonly entrypoint: string;
  readonly nodes: Record<string, AssembledPipelineNode>;
}
