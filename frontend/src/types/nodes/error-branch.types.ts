import { NodeType } from '@/types/pipeline';

/**
 * QUE hace que el flujo se desvie.
 *
 * Es un catalogo de DISPARADORES y no de codigos de error, y la distincion no es
 * cosmetica: "cualquier fallo" NO es un codigo. El motor lo expresa con la forma
 * de cadena de `onErrorStep`, mientras que un fallo concreto exige la forma
 * selectiva con su `catchErrors`. Ofrecer al operador una lista de codigos con
 * un comodin inventado dentro —un `ANY_GRAVE_ERROR`— produciria una ruta que el
 * backend guarda sin protestar y que no se dispara nunca.
 */
export type ErrorBranchTrigger = 'CUALQUIER_FALLO' | 'SIN_TEXTO_EXTRAIBLE';

/** QUE se hace cuando se dispara. */
export type ErrorBranchAction = 'ALERTA_SMTP' | 'VISION_IA';

/** Codigo formal del parser cuando el correo no trae texto aprovechable. */
export const ERR_PARSER_UNEXTRACTABLE_MEDIA = 'ERR_PARSER_UNEXTRACTABLE_MEDIA';

/**
 * Alias del codigo anterior, para leerlo por lo que significa en la interfaz.
 *
 * VIVE AQUI y no en `@/types/pipeline`, que es donde encajaria por tema: aquel
 * archivo no puede importar de este porque este ya importa `NodeType` de aquel,
 * y reexportarlo cerraba un ciclo que dejaba el enum `undefined` en tiempo de
 * evaluacion — el sintoma fue medio suite cayendo con
 * "Cannot read properties of undefined (reading 'PARSER_PRE_IA')".
 *
 * Es un alias y no una segunda constante: dos cadenas iguales divergen a la
 * primera edicion, y el sintoma seria una ruta que se guarda bien y no se
 * dispara nunca.
 */
export const MULTIMODAL_FALLBACK_CODE = ERR_PARSER_UNEXTRACTABLE_MEDIA;

/** Definicion de un disparador para el selector cerrado. */
export interface ErrorBranchTriggerOption {
  readonly label: string;
  readonly hint: string;
  /**
   * Codigo que va a `catchErrors`, o `null` para la forma de cadena.
   *
   * `null` NO significa "sin codigo declarado": significa OTRA FORMA. Quien
   * ensambla el esquema conmuta sobre este valor para elegir entre la cadena
   * —que atrapa todo— y el objeto selectivo.
   */
  readonly catchCode: string | null;
  /**
   * Tipos de nodo que pueden ofrecer este disparador; vacio significa todos.
   *
   * El fallo por medios sin texto solo lo emite el parser, y ofrecerlo en un
   * mapeador crearia una rama muerta que ninguna regla del backend detecta —la
   * regla 10 solo consulta al nodo que SI puede emitirlo.
   */
  readonly onlyForNodeTypes: readonly NodeType[];
}

/** Catalogo cerrado de disparadores (Poka-Yoke, `frontend-quasar.md` §4). */
export const ERROR_BRANCH_TRIGGERS: Record<ErrorBranchTrigger, ErrorBranchTriggerOption> = {
  CUALQUIER_FALLO: {
    label: 'Cualquier error grave o caida de servicio',
    hint: 'El desvio se aplica ante cualquier fallo del paso, sea de configuracion, de red o del proveedor.',
    catchCode: null,
    onlyForNodeTypes: [],
  },
  SIN_TEXTO_EXTRAIBLE: {
    label: 'Documento sin texto / solo imagen o PDF escaneado',
    hint: 'Solo se desvia cuando el correo no trae texto que un modelo pueda leer. Cualquier otro fallo detiene el flujo.',
    catchCode: ERR_PARSER_UNEXTRACTABLE_MEDIA,
    onlyForNodeTypes: [NodeType.PARSER_PRE_IA],
  },
};

/** Definicion de una accion de respaldo para el selector cerrado. */
export interface ErrorBranchActionOption {
  readonly label: string;
  readonly hint: string;
  /** Tipo del nodo que atiende el desvio. */
  readonly targetNodeType: NodeType;
  /**
   * Si el asistente puede CREAR el nodo destino cuando el flujo no lo tiene.
   *
   * Solo la alerta por correo lo permite. La ruta de vision apunta al
   * `PROCESADOR_IA` que el flujo YA tiene: crear uno nuevo chocaria con el
   * existente en el namespace `llm_response` (regla 5 del validador), y ademas
   * ese tipo todavia no tiene configurador con el que rellenar su prompt.
   */
  readonly canProvision: boolean;
  /**
   * Tipos de nodo que pueden declarar esta accion; vacio significa todos.
   *
   * Acota tambien a que nodos se les aplican los `sourceParams`, y eso no es un
   * detalle: `failOnUnextractableMedia` solo existe en `ParserEmailConfigDto`, y
   * escribirlo en un mapeador lo haria rechazar por `forbidNonWhitelisted`.
   */
  readonly onlyForNodeTypes: readonly NodeType[];
  /**
   * `params` que el nodo FUENTE debe declarar para poder emitir el codigo que
   * la ruta atrapa, con el valor al que vuelven al retirarla.
   *
   * Vive AQUI, junto a la accion que lo exige, y no como una cadena suelta en
   * el store: la regla 10 del validador rechaza una ruta selectiva cuyos
   * `params` la desmienten, y mantener las dos mitades en archivos distintos es
   * justo lo que las hizo divergir —el editor escribia la ruta y nadie encendia
   * el interruptor, asi que `validate-schema` devolvia un 400 con `params: {}`.
   *
   * El valor de reversion es explicito y no una ausencia: borrar la clave la
   * dejaria al defecto del DTO, que hoy coincide pero no tiene por que seguir
   * haciendolo.
   */
  readonly sourceParams: Readonly<Record<string, { readonly on: unknown; readonly off: unknown }>>;
  /**
   * `params` que la accion exige AGUAS ARRIBA, indexados por tipo de nodo.
   *
   * La vision lee los adjuntos de `raw_email`
   * (`LlmExtractorStrategy.collectVisionAttachments`), y esos solo existen si el
   * disparador los ingiere. Sin esto la ruta pasa la validacion, se dispara en
   * produccion y llama al modelo con cero adjuntos: un respaldo mudo, que es el
   * mismo fallo silencioso que la regla 10 evita por el otro lado.
   *
   * NO se revierte al retirar la rama, a diferencia de `sourceParams`: ingerir
   * adjuntos es util por si mismo, y apagarlo seria una perdida silenciosa de
   * algo que el operador pudo querer aparte.
   */
  readonly upstreamParams: Readonly<Partial<Record<NodeType, Record<string, unknown>>>>;
}

export const ERROR_BRANCH_ACTIONS: Record<ErrorBranchAction, ErrorBranchActionOption> = {
  ALERTA_SMTP: {
    label: 'Notificacion por correo (alerta SMTP)',
    hint: 'Envia una carta con el nodo que fallo, su codigo y el payload parcial a las personas que indiques.',
    targetNodeType: NodeType.DESTINO_SMTP,
    canProvision: true,
    onlyForNodeTypes: [],
    // La forma de CADENA atrapa cualquier fallo, asi que no hay codigo concreto
    // que el nodo deba poder emitir: la regla 10 ni siquiera la mira.
    sourceParams: {},
    upstreamParams: {},
  },
  VISION_IA: {
    label: 'Extraccion con vision IA',
    hint: 'Reenvia el correo al nodo de IA del flujo, que leera la imagen o el PDF escaneado en vez del texto.',
    targetNodeType: NodeType.PROCESADOR_IA,
    canProvision: false,
    // El fallo por medios sin texto solo lo emite el parser; ofrecer la vision
    // en otro tipo crearia una rama muerta que ninguna regla del backend ve.
    onlyForNodeTypes: [NodeType.PARSER_PRE_IA],
    sourceParams: { failOnUnextractableMedia: { on: true, off: false } },
    upstreamParams: { [NodeType.TRIGGER_IMAP]: { includeAttachments: true } },
  },
};

/**
 * Identificador del nodo de alerta que el asistente provisiona.
 *
 * UNO POR FLUJO, compartido por todas las ramas, y no uno por nodo fuente. La
 * regla 5 del validador de topologia prohibe que dos nodos escriban el mismo
 * `outputNamespace`, y `smtp_result` es uno solo en la lista cerrada: un
 * satelite por paso devolveria un 400 en cuanto hubiera dos ramas. Compartirlo
 * tampoco pierde informacion, porque `error_context` ya dice que nodo fallo.
 */
export const SHARED_ALERT_NODE_ID = 'alerta_smtp';

/** Ruta de contingencia declarada para un paso del asistente. */
export interface ErrorBranch {
  readonly trigger: ErrorBranchTrigger;
  readonly action: ErrorBranchAction;
}

/** Acciones de respaldo que un tipo de nodo puede ofrecer. */
export const actionsForNodeType = (nodeType: NodeType): ErrorBranchAction[] =>
  (Object.keys(ERROR_BRANCH_ACTIONS) as ErrorBranchAction[]).filter((action) => {
    const { onlyForNodeTypes } = ERROR_BRANCH_ACTIONS[action];

    return onlyForNodeTypes.length === 0 || onlyForNodeTypes.includes(nodeType);
  });

/** Disparadores que un tipo de nodo puede ofrecer. */
export const triggersForNodeType = (nodeType: NodeType): ErrorBranchTrigger[] =>
  (Object.keys(ERROR_BRANCH_TRIGGERS) as ErrorBranchTrigger[]).filter((trigger) => {
    const { onlyForNodeTypes } = ERROR_BRANCH_TRIGGERS[trigger];

    return onlyForNodeTypes.length === 0 || onlyForNodeTypes.includes(nodeType);
  });
