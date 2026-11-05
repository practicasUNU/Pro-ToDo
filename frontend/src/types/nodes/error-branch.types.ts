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

/**
 * Identificador del nodo de transcripcion que el editor provisiona.
 *
 * UNO POR FLUJO, igual que el de alerta y por el mismo motivo: `ocr_result` es
 * un namespace de la lista cerrada y la regla 5 del validador lo declara de un
 * solo dueno, asi que un satelite por paso devolveria un 400 en cuanto hubiera
 * dos ramas de vision.
 */
export const SHARED_OCR_NODE_ID = 'ocr_ia';

/** Definicion de una accion de respaldo para el selector cerrado. */
export interface ErrorBranchActionOption {
  readonly label: string;
  readonly hint: string;
  /** Tipo del nodo que atiende el desvio. */
  readonly targetNodeType: NodeType;
  /**
   * Si el asistente puede CREAR el nodo destino cuando el flujo no lo tiene.
   *
   * Las DOS acciones lo permiten desde que la transcripcion tiene tipo propio.
   * Antes no: la vision apuntaba al `PROCESADOR_IA` del flujo porque un segundo
   * nodo de IA chocaria con el en `llm_response`, y eso obligaba a ofrecer la
   * opcion solo si la topologia ya traia uno. `PROCESADOR_OCR` escribe en
   * `ocr_result` y no colisiona con nadie.
   */
  readonly canProvision: boolean;
  /**
   * `nodeId` del satelite que se provisiona, cuando `canProvision` es cierto.
   *
   * Va en el catalogo y no cableado en el store porque ya son dos: atarlo a
   * `SHARED_ALERT_NODE_ID` obligaba a un `if` por accion en cada sitio que
   * resuelve un destino.
   */
  readonly provisionedNodeId: string | null;
  /**
   * Si el satelite REINCORPORA el flujo en vez de terminarlo.
   *
   * La alerta es terminal —avisa a una persona y ahi acaba—, mientras que la
   * transcripcion devuelve el flujo al curso que llevaba el paso que fallo. Es
   * lo unico que distingue las dos formas de satelite al ensamblar el grafo.
   */
  readonly rejoinsFlow: boolean;
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
   * Accion que atiende el fallo DEL PROPIO SATELITE, o `null` si es terminal.
   *
   * Un satelite tambien puede fallar: la transcripcion se queda sin adjuntos,
   * el proveedor devuelve un 503 o el modelo no saca una sola letra. Sin esta
   * ruta el motor no encuentra a donde desviarse y PAUSA el flujo conservando
   * el cursor —y lo hace aunque el flujo tenga una alerta provisionada cuyo
   * unico cometido es que una persona se entere—. El rescate se quedaba mudo
   * justo cuando fallaba el rescate.
   *
   * Es una ACCION y no un `nodeId` para no cablear `alerta_smtp` por segunda
   * vez: el identificador sale de `provisionedNodeId` de la accion nombrada,
   * que ya es el unico dueno de ese dato.
   *
   * `null` en la alerta a proposito: es terminal, y apuntarse a si misma seria
   * un bucle que la regla 6 del validador ni siquiera mira —`onErrorStep` queda
   * fuera de su recorrido—, asi que solo se descubriria en ejecucion.
   */
  readonly satelliteFallbackAction: ErrorBranchAction | null;

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
    provisionedNodeId: SHARED_ALERT_NODE_ID,
    rejoinsFlow: false,
    onlyForNodeTypes: [],
    // La forma de CADENA atrapa cualquier fallo, asi que no hay codigo concreto
    // que el nodo deba poder emitir: la regla 10 ni siquiera la mira.
    sourceParams: {},
    upstreamParams: {},
    // Terminal: avisa a una persona y ahi acaba.
    satelliteFallbackAction: null,
  },
  VISION_IA: {
    label: 'Extraccion con vision IA',
    hint: 'Anade un nodo de transcripcion que leera la imagen o el PDF escaneado y devolvera el flujo a su curso con el texto recuperado.',
    targetNodeType: NodeType.PROCESADOR_OCR,
    canProvision: true,
    provisionedNodeId: SHARED_OCR_NODE_ID,
    rejoinsFlow: true,
    // El fallo por medios sin texto solo lo emite el parser; ofrecer la vision
    // en otro tipo crearia una rama muerta que ninguna regla del backend ve.
    onlyForNodeTypes: [NodeType.PARSER_PRE_IA],
    sourceParams: { failOnUnextractableMedia: { on: true, off: false } },
    upstreamParams: { [NodeType.TRIGGER_IMAP]: { includeAttachments: true } },
    // Si la transcripcion no saca texto, que al menos lo cuente.
    satelliteFallbackAction: 'ALERTA_SMTP',
  },
};

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
