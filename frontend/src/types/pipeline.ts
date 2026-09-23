// Replica exacta de los contratos del motor FSM (NestJS). Cualquier cambio en
// `@core/fsm/types/pipeline-schema.types.ts` debe reflejarse aqui.

/**
 * Tipos de nodo admitidos por el pipeline. Enum real (no `type`) porque se
 * recorre en tiempo de ejecucion para poblar selectores y el registro de
 * componentes de configuracion.
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
}

/** Etiquetas legibles para los selectores; el enum viaja crudo al backend. */
export const NODE_TYPE_LABELS: Record<NodeType, string> = {
  [NodeType.TRIGGER_IMAP]: 'Disparador IMAP',
  [NodeType.TRIGGER_CRON]: 'Disparador Cron',
  [NodeType.PARSER_PRE_IA]: 'Parser de Correo',
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
 * Namespaces que un nodo puede declarar como `outputNamespace`.
 *
 * Replica de `NODE_OUTPUT_NAMESPACES` del backend. Es una lista CERRADA: el
 * validador de topologia rechaza cualquier valor fuera de ella, asi que el
 * campo se ofrece como selector y nunca como texto libre (Poka-Yoke).
 *
 * `TEMPLATE_NAMESPACES` (`@/types/html-template`) se deriva de esta lista
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
] as const;

/**
 * Namespace de salida que se asigna a un nodo recien anadido al flujo.
 *
 * Replica de `NODE_OUTPUT_NAMESPACES` (`@core/fsm/types/pipeline-schema.types`)
 * repartida por tipo. El `outputNamespace` NO se puede derivar del `nodeId`:
 * son dos identificadores con dominios distintos —el `nodeId` desambigua nodos
 * dentro del grafo, el namespace es la raiz de `{{ns.campo}}` en las plantillas
 * y pertenece a una lista cerrada—, y confundirlos dejaba a un TRIGGER_IMAP
 * escribiendo en `trigger_imap`, que ninguna plantilla puede interpolar.
 *
 * Se declara como `Record<NodeType, string>` y no como un mapa parcial para que
 * el compilador exija una entrada al dar de alta un tipo de nodo nuevo.
 */
export const DEFAULT_OUTPUT_NAMESPACE_BY_NODE_TYPE: Record<NodeType, string> = {
  [NodeType.TRIGGER_IMAP]: 'raw_email',
  [NodeType.TRIGGER_CRON]: 'cron_trigger',
  [NodeType.PARSER_PRE_IA]: 'parsed_email',
  [NodeType.EXTRACTOR_WEB]: 'scraped_web',
  [NodeType.PROCESADOR_IA]: 'llm_response',
  [NodeType.ESCUDO_POST_IA]: 'validated_drupal_json',
  [NodeType.MAPEADOR_PLANTILLA]: 'rendered_html',
  [NodeType.DESTINO_HTTP]: 'http_result',
};

/**
 * `params` base que se siembran al anadir un nodo a una PLANTILLA.
 *
 * Son valores de arranque de la topologia, no configuracion de operacion: el
 * host, el usuario y la clave de un buzon se piden en el asistente al instanciar
 * el flujo, y no tienen por que vivir en una plantilla que se reutiliza.
 *
 * Solo se declara aqui lo que tiene un control dedicado en
 * `nodeBaseParamsRegistry`, o un default que el operador no deberia teclear. Los
 * tipos sin parametros base van a `{}` a proposito: desde que el editor JSON
 * crudo desaparecio, un nodo sin entrada aqui simplemente no pinta controles.
 *
 * `Record<NodeType, …>` completo y no parcial, igual que su hermano de arriba,
 * para que el compilador exija una entrada al dar de alta un tipo nuevo.
 */
export const DEFAULT_PARAMS_BY_NODE_TYPE: Record<NodeType, Record<string, unknown>> = {
  [NodeType.TRIGGER_IMAP]: { mailbox: 'INBOX', includeAttachments: false },
  [NodeType.TRIGGER_CRON]: {},
  [NodeType.PARSER_PRE_IA]: {},
  [NodeType.EXTRACTOR_WEB]: {},
  [NodeType.PROCESADOR_IA]: {},
  [NodeType.ESCUDO_POST_IA]: {},
  [NodeType.MAPEADOR_PLANTILLA]: {},
  [NodeType.DESTINO_HTTP]: {},
};

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

/**
 * Flujo YA INSTANCIADO, tal como lo devuelve `GET /api/workflows`.
 *
 * Replica de `PipelineSummaryResponseDto`. Es lo que pinta el catalogo de
 * `/flujos`; el selector del asistente NO lo consume: desde la migracion 010
 * parte de `WorkflowTemplateSummary`, que son los blueprints maestros.
 */
export interface PipelineSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly active: boolean;
  /** Plantilla de la que se instancio, o `null` si nacio desde cero. */
  readonly templateId: string | null;
  /** Pasos EN ORDEN DE EJECUCION, ya resueltos por el backend. */
  readonly topology: PipelineStep[];
}

/**
 * Un flujo con su grafo COMPLETO, `params` incluidos (`GET /workflows/:id`).
 *
 * Es lo que el asistente de edicion hidrata. El listado (`PipelineSummary`)
 * elimina los `params` a proposito, asi que no sirve para reconstruir el
 * formulario: llevaria el host y el buzon en blanco y guardar los borraria.
 *
 * `pipelineSchema` es nulo en un flujo a medio crear que aun no tiene grafo.
 */
export interface WorkflowDetail extends PipelineSummary {
  readonly pipelineSchema: AssembledPipelineSchema | null;
}

/**
 * Plantilla de flujo (blueprint maestro) del catalogo `plantillas_flujo`.
 *
 * Replica de `WorkflowTemplateResponseDto`. Es la fuente de la Fase 0 del
 * asistente y de la tabla administrativa. NO trae `pipelineSchema`: los `params`
 * de un TRIGGER_IMAP llevan `host` y `passwordEnvKey`, y para dibujar la
 * secuencia de pasos basta la topologia proyectada.
 */
export interface WorkflowTemplateSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly active: boolean;
  readonly topology: PipelineStep[];
  /**
   * Politica que el flujo instanciado hereda de la plantilla.
   *
   * Viaja PROYECTADA y no dentro del esquema, por el mismo motivo que
   * `topology`: el listado no trae `pipelineSchema`. Ausente si la plantilla no
   * declara ninguna.
   */
  readonly executionPolicy?: PipelineExecutionPolicy;
}

/**
 * Plantilla con su grafo completo, para el editor administrativo.
 *
 * Replica de `WorkflowTemplateDetailResponseDto`. Solo la devuelve
 * `GET /api/workflow-templates/:id`, porque es el objeto que el CRUD edita.
 */
export interface WorkflowTemplateDetail extends WorkflowTemplateSummary {
  readonly pipelineSchema: Record<string, unknown>;
}

/** Cuerpo de `POST /api/workflow-templates`. */
export interface CreateWorkflowTemplatePayload {
  readonly name: string;
  readonly description?: string;
  readonly pipelineSchema: Record<string, unknown>;
  readonly active?: boolean;
}

/**
 * Cuerpo de `PUT /api/workflow-templates/:id`.
 *
 * Todos los campos opcionales: un solo verbo cubre editar, activar e inactivar.
 */
export type UpdateWorkflowTemplatePayload = Partial<CreateWorkflowTemplatePayload>;

/**
 * Cuerpo de `PATCH /api/workflows/:id`.
 *
 * NO incluye `templateId`, y no es una omision: el maestro del que nacio un
 * flujo es un hecho historico y el backend rechaza reescribirlo.
 */
export interface UpdateWorkflowPayload {
  readonly name?: string;
  readonly description?: string;
  readonly active?: boolean;
  readonly pipelineSchema?: AssembledPipelineSchema;
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

/**
 * Campo invalido devuelto por `POST /fsm/validate-schema`.
 *
 * Replica de `SchemaIssueDto` del backend. `path` es una RUTA dentro del
 * documento JSON (`nodes.trigger_imap.params.mailbox`), no el nombre de un
 * control: el editor la resuelve a una posicion para dibujar el subrayado.
 *
 * Hay un elemento por REGLA incumplida, no por campo: un mismo `path` puede
 * repetirse con mensajes distintos.
 */
export interface SchemaIssue {
  readonly path: string;
  readonly message: string;
}

/** Respuesta 200 de la validacion de un esquema. */
export interface ValidateSchemaResult {
  readonly success: true;
  readonly schema: AssembledPipelineSchema;
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
  /**
   * Plantilla de la que parte el flujo.
   *
   * Solo trazabilidad: el flujo viaja con su PROPIA copia del grafo en
   * `pipelineSchema`, asi que editar la plantilla despues no lo altera.
   */
  readonly templateId?: string;
}

/**
 * Ruta de recuperacion que solo atrapa los codigos de error declarados.
 *
 * Replica de `SelectiveErrorFallback` del backend.
 */
export interface SelectiveErrorFallback {
  readonly targetNode: string;
  readonly catchErrors: readonly string[];
}

/** Nodo del `pipeline_schema` tal como lo ensambla el asistente. */
export interface AssembledPipelineNode {
  readonly nodeId: string;
  readonly nodeType: NodeType;
  readonly outputNamespace: string;
  readonly nextStep: string | null;
  /**
   * Cadena (respaldo incondicional), ruta selectiva, o `null` para detener.
   *
   * El asistente solo emite `null`; la union se replica porque el tipo describe
   * lo que el backend ACEPTA, y un esquema editado a mano en el panel JSON de
   * plantillas puede traer cualquiera de las tres formas.
   */
  readonly onErrorStep: string | SelectiveErrorFallback | null;
  readonly params: Record<string, unknown>;
}

/**
 * Politica del flujo COMPLETO, frente a la de reintentos, que es por nodo.
 *
 * Replica de `PipelineExecutionPolicy` del backend. Viaja dentro del
 * `pipeline_schema`, asi que se propaga sola de la plantilla al flujo
 * instanciado siempre que quien reensambla el esquema la conserve.
 */
export interface PipelineExecutionPolicy {
  /**
   * Desactiva el flujo tras la primera ejecucion que recorra el grafo entero.
   *
   * Una ejecucion detenida por un disparador sin datos NO cuenta: el backend lo
   * distingue para no apagar un flujo IMAP en su primer sondeo en vacio.
   */
  readonly stopOnFirstSuccess?: boolean;
}

/** Grafo completo que el asistente envia al backend. */
export interface AssembledPipelineSchema {
  readonly flowId: string;
  readonly name: string;
  readonly version: string;
  readonly entrypoint: string;
  readonly nodes: Record<string, AssembledPipelineNode>;
  readonly executionPolicy?: PipelineExecutionPolicy;
}
