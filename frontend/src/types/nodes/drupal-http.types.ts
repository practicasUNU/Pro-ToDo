// Replica del contrato de `DrupalHttpConfigDto` (backend). Cualquier cambio
// alla debe reflejarse aqui.
//
// El DTO se valida con `{ whitelist: true, forbidNonWhitelisted: true }`: una
// clave que no figure alli es un 400 al guardar el flujo, no un campo ignorado.
// Por eso esta replica enumera EXACTAMENTE los 22 params y ni uno mas.

/**
 * Modos operativos del nodo contra Drupal JSON:API.
 *
 * Son cinco trabajos distintos sobre el mismo CMS y no cinco variantes del
 * mismo, de ahi que cada uno pida sus propios campos: `CREATE_NODE` crea una
 * entidad propia, los dos de bloques mutan el `body.value` de una pagina
 * AGREGADORA, `UPDATE_LINK_SOURCE` cambia un unico `href`/`src` (Innodays) y
 * `UPLOAD_ATTACHMENT` sube un binario.
 */
export enum DrupalOperationMode {
  CREATE_NODE = 'CREATE_NODE',
  APPEND_HTML_BLOCK = 'APPEND_HTML_BLOCK',
  TRANSFER_HTML_BLOCK = 'TRANSFER_HTML_BLOCK',
  UPDATE_LINK_SOURCE = 'UPDATE_LINK_SOURCE',
  UPLOAD_ATTACHMENT = 'UPLOAD_ATTACHMENT',
}

/** Atributo que reescribe `UPDATE_LINK_SOURCE`. Replica de `DrupalLinkAttribute`. */
export type DrupalLinkAttribute = 'href' | 'src';

export const DRUPAL_LINK_ATTRIBUTES: readonly DrupalLinkAttribute[] = ['href', 'src'];

export const DEFAULT_DRUPAL_LINK_ATTRIBUTE: DrupalLinkAttribute = 'href';

/** Tope de la plantilla del nuevo enlace, replicado de `MAX_DRUPAL_LINK_TEMPLATE_LENGTH`. */
export const MAX_DRUPAL_LINK_TEMPLATE_LENGTH = 2048;

/**
 * Entorno por defecto: el de pruebas. Replica de `DEFAULT_DRUPAL_IS_SANDBOX`.
 *
 * Equivocarse hacia este lado cuesta repetir una prueba; hacia el otro,
 * publicar en el portal real.
 */
export const DEFAULT_DRUPAL_IS_SANDBOX = true;

/** Los dos entornos del portal: las paginas de pruebas y las publicas. */
export type DrupalEnvironment = 'SANDBOX' | 'PRODUCTION';

/** Rotulo del entorno, el que acompana a cada boton de preset. */
export const DRUPAL_ENVIRONMENT_LABELS: Readonly<Record<DrupalEnvironment, string>> = {
  SANDBOX: 'Sandbox',
  PRODUCTION: 'Producción',
};

/** Entorno al que apunta el toggle. */
export const toDrupalEnvironment = (isSandbox: boolean): DrupalEnvironment =>
  isSandbox ? 'SANDBOX' : 'PRODUCTION';

/** Donde se inserta un bloque nuevo dentro del contenedor de la pagina. */
export type DrupalInsertPosition = 'PREPEND' | 'APPEND';

export const DRUPAL_INSERT_POSITIONS: readonly DrupalInsertPosition[] = ['PREPEND', 'APPEND'];

export const DEFAULT_DRUPAL_MODE = DrupalOperationMode.CREATE_NODE;

/**
 * Bundle destino, en la forma `entidad--bundle` de JSON:API.
 *
 * REPLICA de `DEFAULT_DRUPAL_BUNDLE`. Es literalmente el `data.type` del
 * payload, y de el se deriva tambien la ruta de coleccion
 * (`node--noticias` -> `/node/noticias`).
 */
export const DEFAULT_DRUPAL_BUNDLE = 'node--noticias';

/**
 * Namespace del que se lee el markup a publicar.
 *
 * REPLICA de `DEFAULT_DRUPAL_SOURCE_NAMESPACE`. Es el `outputNamespace`
 * canonico del `ESCUDO_POST_IA`, el nodo al que este destino sigue por diseno.
 */
export const DEFAULT_DRUPAL_SOURCE_NAMESPACE = 'validated_drupal_json';

/**
 * Campo del que se lee el markup.
 *
 * REPLICA de `DEFAULT_DRUPAL_SOURCE_FIELD`. `validated_markup` y NO
 * `compiled_markup`: aquel existe, pero en `rendered_html`, y contiene la
 * plantilla base SIN interpolar. Apuntar ahi no fallaria —publicaria un
 * articulo en blanco, con 200 OK y sin alerta—, que es peor que no encontrar la
 * clave.
 */
export const DEFAULT_DRUPAL_SOURCE_FIELD = 'validated_markup';

/** Campo de texto largo de la entidad. En Drupal estandar es `body`. */
export const DEFAULT_DRUPAL_BODY_FIELD = 'body';

/** Formato de texto con el que Drupal renderiza el markup publicado. */
export const DEFAULT_DRUPAL_BODY_FORMAT = 'full_html';

/** Una licitacion nueva se lee arriba: lo ultimo publicado va primero. */
export const DEFAULT_DRUPAL_INSERT_POSITION: DrupalInsertPosition = 'PREPEND';

/**
 * Namespace del que sale el binario de un adjunto.
 *
 * REPLICA de `DEFAULT_DRUPAL_ATTACHMENT_NAMESPACE`. `raw_email` y NO
 * `parsed_email`, y es una restriccion dura del motor: el parser publica el
 * INVENTARIO de adjuntos sin `contentBase64`, asi que ahi no hay bytes que
 * subir. Ni siquiera `raw_email` los conserva indefinidamente —el motor los
 * libera en cuanto cualquier nodo publica texto aprovechable—, de modo que un
 * `UPLOAD_ATTACHMENT` tiene que ir ANTES del nodo que extrae texto.
 */
export const DEFAULT_DRUPAL_ATTACHMENT_NAMESPACE = 'raw_email';

/** Clave del inventario de adjuntos dentro de ese namespace. */
export const DEFAULT_DRUPAL_ATTACHMENT_FIELD = 'attachments';

/** Primer adjunto del correo, que es el caso normal de una licitacion. */
export const DEFAULT_DRUPAL_ATTACHMENT_INDEX = 0;

/** Tope del indice de adjunto, replicado de `MAX_DRUPAL_ATTACHMENT_INDEX`. */
export const MAX_DRUPAL_ATTACHMENT_INDEX = 50;

/** Campo de fichero del nodo anfitrion al que se adjunta el binario. */
export const DEFAULT_DRUPAL_FILE_FIELD_NAME = 'field_adjuntos';

/**
 * Interruptor de la subida dentro de `APPEND_HTML_BLOCK`.
 *
 * Apagado por defecto: subir un fichero es un efecto externo, y esos no se
 * encienden por omision.
 */
export const DEFAULT_DRUPAL_UPLOAD_ATTACHMENT = false;

/** Lista del bloque que recibe el enlace al fichero subido. */
export const DEFAULT_DRUPAL_ATTACHMENT_LIST_SELECTOR = 'ul.licitacion-pliegos';

/** Tope del titulo: es el limite de `node.title` en Drupal estandar. */
export const MAX_DRUPAL_TITLE_LENGTH = 255;

/** Tope del resumen, replicado de `MAX_DRUPAL_SUMMARY_LENGTH`. */
export const MAX_DRUPAL_SUMMARY_LENGTH = 2000;

/**
 * Tope de un selector CSS.
 *
 * El DTO del backend lo importa de `template-mapper-config.dto`; aqui se
 * replica el valor en vez de importarlo de `post-ia-sanitizer.types` para no
 * atar dos nodos que no tienen nada que ver mas alla de compartir una cifra.
 */
export const MAX_DRUPAL_SELECTOR_LENGTH = 120;

/**
 * Forma de un `data.type` de JSON:API: `entidad--bundle`.
 *
 * REPLICA de `DRUPAL_BUNDLE_PATTERN`. Se exige el doble guion porque de el
 * depende la derivacion de la ruta: sin separador no hay forma de saber donde
 * acaba la entidad y empieza el bundle.
 */
export const DRUPAL_BUNDLE_PATTERN = /^[a-z0-9_]+--[a-z0-9_]+$/;

/** Nombre de campo dentro de un namespace o de una entidad: snake_case. */
export const DRUPAL_FIELD_NAME_PATTERN = /^[a-z0-9_]+$/;

/** UUID v4, el identificador con el que JSON:API direcciona cada entidad. */
export const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Bundles confirmados en produccion, para el selector CERRADO (Poka-Yoke §4).
 *
 * La lista es de CONVENIENCIA y no de seguridad: el backend acepta cualquier
 * cadena que case con `DRUPAL_BUNDLE_PATTERN`, porque no puede conocer el
 * catalogo de un CMS ajeno. Lo que evita es que el operador teclee
 * `node-noticias` —un solo guion— y descubra el fallo con el flujo ya guardado.
 */
export const DRUPAL_BUNDLES: readonly string[] = [
  'node--noticias',
  'node--article',
  'node--page',
  'node--acreditacion_evaluacion_panel',
];

/**
 * Pagina de un preset en UN entorno.
 *
 * `null` en los UUID significa «lo pone el operador». Es lo que vale para todo
 * destino cuyo UUID no esta confirmado —todos los de Produccion, Innodays y la
 * pagina de licitaciones cerradas—: sembrar un UUID inventado para «dejarlo
 * relleno» seria el peor de los rellenos. El patron v4 casaria, el paso quedaria
 * valido y el fallo saldria en ejecucion como un 404 con el flujo ya PAUSADO.
 * Nulo, `isConfigValid` lo reclama en el momento de configurar.
 */
export interface DrupalPresetTarget {
  /** Ruta publica de la pagina, para que el operador sepa a donde apunta. */
  readonly path: string;

  /** Identificador interno del nodo en Drupal. Informativo: la API usa el UUID. */
  readonly nid: number | null;

  /** Pagina o entidad sobre la que actua el destino. */
  readonly targetNodeUuid: string | null;

  /** Pagina receptora, solo en `TRANSFER_HTML_BLOCK`. */
  readonly destinationNodeUuid: string | null;
}

/**
 * Un destino operativo completo, para los botones de carga rapida.
 *
 * Declara TODO lo que el modo elegido necesita, y no solo el identificador: un
 * `TRANSFER_HTML_BLOCK` sin `itemSelector` o un `APPEND_HTML_BLOCK` sin bundle
 * no son configuraciones a medias, son configuraciones que fallan en ejecucion.
 *
 * Lo que cambia entre Sandbox y Produccion es SOLO la pagina (`environments`):
 * modo, bundle y selectores son los mismos, porque las paginas de pruebas son
 * copias de las publicas.
 */
export interface DrupalPreset {
  /** Rotulo base del boton; el entorno se le anade al pintarlo. */
  readonly label: string;

  /** Que hace este destino, para el `q-tooltip`. */
  readonly description: string;

  readonly operationMode: DrupalOperationMode;
  readonly bundle: string;
  readonly containerSelector: string | null;
  readonly itemSelector: string | null;
  readonly insertPosition: DrupalInsertPosition;

  /** Estado de publicacion de lo que se crea. Solo lo lee `CREATE_NODE`. */
  readonly publishStatus: boolean;

  /** Selector y atributo de `UPDATE_LINK_SOURCE`; `null` en los demas modos. */
  readonly linkSelector: string | null;
  readonly linkAttribute: DrupalLinkAttribute;

  /**
   * Plantilla de `plantillas_html` que acompana a este destino.
   *
   * Es una PISTA para el operador —se muestra en el tooltip—, no una clave
   * ajena: nada la resuelve ni la valida. El nodo que elige plantilla es el
   * MAPEADOR_PLANTILLA, varios pasos antes, y un store de nodo no puede leer el
   * de otro (`frontend-quasar.md` §3.1).
   */
  readonly associatedTemplateName: string | null;

  /** La pagina de este destino en cada entorno. */
  readonly environments: Readonly<Record<DrupalEnvironment, DrupalPresetTarget>>;
}

/** UUID de la pagina agregadora de licitaciones de PRUEBAS (`/prueba-licitaciones`). */
const SANDBOX_LICITACIONES_UUID = '7f1700bf-b54b-4c12-b71a-8a71f1f0ee38';

/** UUID de la pagina de verificacion de titulos de PRUEBAS. */
const SANDBOX_TITULOS_UUID = 'b17d69d8-6998-4883-b8dc-153b55dbd9c5';

/**
 * Destinos operativos del Drupal de Madrid+D, en el ORDEN en que se pintan.
 *
 * Los UUID son publicos, no credenciales: viajan en el bundle sin exponer nada.
 * El token (`DRUPAL_API_TOKEN`) vive exclusivamente en `backend/.env` y jamas
 * llega al cliente (`security-and-scope.md` §0.1).
 *
 * Existen porque teclear un UUID v4 a mano es el error mas caro de este
 * formulario: un digito cambiado no se detecta al guardar —el patron sigue
 * casando— sino en ejecucion, con un 404 de Drupal y el flujo ya PAUSADO.
 */
export const DRUPAL_PRESETS: Readonly<
  Record<
    'ABRIR_LICITACION' | 'CERRAR_LICITACION' | 'VERIFICACION_TITULOS' | 'INNODAYS' | 'NOTIWEB',
    DrupalPreset
  >
> = {
  ABRIR_LICITACION: {
    label: 'Abrir licitación',
    description:
      'Antepone el bloque de la convocatoria a la página agregadora de licitaciones abiertas.',
    operationMode: DrupalOperationMode.APPEND_HTML_BLOCK,
    bundle: 'node--page',
    // Panel desplegable de "convocatorias abiertas" en la pagina agregadora.
    // Sin el, el bloque se antepondria al cuerpo entero del nodo y quedaria
    // fuera del acordeon que el portal presenta.
    containerSelector: '#collapse2 > .panel-body',
    itemSelector: null,
    // Lo ultimo convocado se lee arriba, que es como el portal presenta la lista.
    insertPosition: 'PREPEND',
    publishStatus: true,
    linkSelector: null,
    linkAttribute: DEFAULT_DRUPAL_LINK_ATTRIBUTE,
    associatedTemplateName: 'Licitaciones · Convocatoria abierta (Madrid+D)',
    environments: {
      SANDBOX: {
        path: '/prueba-licitaciones',
        nid: 55937,
        targetNodeUuid: SANDBOX_LICITACIONES_UUID,
        destinationNodeUuid: null,
      },
      PRODUCTION: {
        path: '/convocatorias-abiertas',
        nid: null,
        targetNodeUuid: null,
        destinationNodeUuid: null,
      },
    },
  },
  CERRAR_LICITACION: {
    label: 'Cerrar licitación',
    description:
      'Traslada un bloque de licitación desde la página de abiertas a la de cerradas. Exige indicar a mano la página de destino.',
    operationMode: DrupalOperationMode.TRANSFER_HTML_BLOCK,
    bundle: 'node--page',
    containerSelector: null,
    // La clase del envoltorio que siembra la plantilla de apertura. Afinarla a
    // un expediente concreto (`[data-expediente="..."]`) es trabajo del flujo.
    itemSelector: '.licitacion-entry',
    // En cerradas el orden cronologico se lee al reves: lo ultimo en cerrarse va
    // al final, detras de lo que lleva mas tiempo archivado.
    insertPosition: 'APPEND',
    publishStatus: true,
    linkSelector: null,
    linkAttribute: DEFAULT_DRUPAL_LINK_ATTRIBUTE,
    associatedTemplateName: 'Licitaciones · Convocatoria cerrada (Madrid+D)',
    environments: {
      // La pagina de cerradas queda nula en los dos entornos. Apuntarla a la de
      // abiertas «para probar» seria destructivo: `runTransferHtmlBlock` lee
      // origen y destino por separado y el segundo PATCH pisa al primero con un
      // DOM ya obsoleto, de modo que el bloque se borra sin dejar copia.
      SANDBOX: {
        path: '/prueba-licitaciones → /prueba-licitaciones-cerradas',
        nid: 55937,
        targetNodeUuid: SANDBOX_LICITACIONES_UUID,
        destinationNodeUuid: null,
      },
      PRODUCTION: {
        path: '/convocatorias-abiertas → /convocatorias-cerradas',
        nid: null,
        targetNodeUuid: null,
        destinationNodeUuid: null,
      },
    },
  },
  VERIFICACION_TITULOS: {
    label: 'Verificación de títulos',
    description:
      'Antepone el panel colapsable del comité dentro del acordeón de la página agregadora.',
    // APPEND_HTML_BLOCK y no CREATE_NODE: lo que el portal presenta es un
    // ACORDEON, y cada comite es un panel colapsable DENTRO del HTML de la
    // pagina agregadora, no un nodo suelto.
    operationMode: DrupalOperationMode.APPEND_HTML_BLOCK,
    bundle: 'node--page',
    // Acordeon RAIZ del portal, y es un RESPALDO, no el destino: el destino
    // real lo decide cada panel por su `data-parent`, y la estrategia lo reparte
    // al sub-acordeon de su universidad.
    containerSelector: '#accordion',
    // El envoltorio que siembra la plantilla base, equivalente a
    // `.licitacion-entry` en el canal de licitaciones.
    itemSelector: '.panel-default',
    // Al FINAL: el destino es el sub-acordeon de UNA universidad, donde los
    // comites se leen como un listado estable, no como una lista cronologica.
    insertPosition: 'APPEND',
    publishStatus: true,
    linkSelector: null,
    linkAttribute: DEFAULT_DRUPAL_LINK_ATTRIBUTE,
    associatedTemplateName: 'Verificación de Títulos · Panel de evaluación',
    environments: {
      SANDBOX: {
        path: '/prueba-verificador-titulos',
        nid: 55938,
        targetNodeUuid: SANDBOX_TITULOS_UUID,
        destinationNodeUuid: null,
      },
      PRODUCTION: {
        path: '/titulos',
        nid: null,
        targetNodeUuid: null,
        destinationNodeUuid: null,
      },
    },
  },
  INNODAYS: {
    label: 'Innodays',
    description:
      'Actualiza el href o el src de UN elemento de la página de Innodays madri+d (un PDF de la tabla, una imagen del carrusel) sin tocar el resto del HTML.',
    operationMode: DrupalOperationMode.UPDATE_LINK_SOURCE,
    bundle: 'node--page',
    containerSelector: null,
    itemSelector: null,
    insertPosition: DEFAULT_DRUPAL_INSERT_POSITION,
    publishStatus: true,
    // El elemento depende de cada edicion (que fila, que imagen): lo escribe el
    // operador. El placeholder del campo muestra la forma.
    linkSelector: null,
    linkAttribute: 'href',
    associatedTemplateName: null,
    environments: {
      SANDBOX: {
        path: '/prueba-innodays',
        nid: null,
        targetNodeUuid: null,
        destinationNodeUuid: null,
      },
      PRODUCTION: {
        path: '/innodays',
        nid: null,
        targetNodeUuid: null,
        destinationNodeUuid: null,
      },
    },
  },
  NOTIWEB: {
    label: 'Notiweb',
    description:
      'Da de alta una noticia individual de Notiweb, DESPUBLICADA: un editor la revisa y la publica en Drupal. No cuelga de ninguna página agregadora.',
    operationMode: DrupalOperationMode.CREATE_NODE,
    bundle: 'node--noticias',
    containerSelector: null,
    itemSelector: null,
    insertPosition: 'PREPEND',
    // Borrador: `status = false` al crear, en los dos entornos.
    publishStatus: false,
    linkSelector: null,
    linkAttribute: DEFAULT_DRUPAL_LINK_ATTRIBUTE,
    associatedTemplateName: 'Notiweb · Noticia institucional',
    environments: {
      // Sin pagina receptora: este canal crea entidades sueltas.
      SANDBOX: {
        path: '/prueba-noticias',
        nid: null,
        targetNodeUuid: null,
        destinationNodeUuid: null,
      },
      PRODUCTION: { path: '/noticias', nid: null, targetNodeUuid: null, destinationNodeUuid: null },
    },
  },
};

/** Claves de `DRUPAL_PRESETS`, para tipar el selector sin `string`. */
export type DrupalPresetKey = keyof typeof DRUPAL_PRESETS;

/** Rotulo del boton con su entorno: «Innodays (Sandbox)». */
export const describePresetLabel = (preset: DrupalPreset, isSandbox: boolean): string =>
  `${preset.label} (${DRUPAL_ENVIRONMENT_LABELS[toDrupalEnvironment(isSandbox)]})`;

/**
 * Configuracion del nodo `DESTINO_DRUPAL` en el cliente.
 *
 * NINGUN campo es opcional, aunque el DTO del backend los admita todos
 * ausentes: un `undefined` enlazado a un control de Quasar lo convierte en
 * campo descontrolado y avisa por consola en cada pulsacion. La ausencia se
 * representa con `null` —nunca omitiendo la clave, que `exactOptionalPropertyTypes`
 * trataria como una segunda forma de ausencia—, y es `toNodeParams()` quien
 * decide que se publica en el `pipeline_schema` y que se omite.
 */
export interface DrupalHttpNodeConfig {
  /** Entorno: paginas de pruebas (`true`) o del portal. Lo gobierna el toggle. */
  isSandbox: boolean;
  operationMode: DrupalOperationMode;
  bundle: string;
  sourceNamespace: string;
  sourceField: string;
  titleTemplate: string | null;
  summaryTemplate: string | null;
  bodyFieldName: string;
  bodyFormat: string;
  publishStatus: boolean;
  targetNodeUuid: string | null;
  destinationNodeUuid: string | null;
  containerSelector: string | null;
  itemSelector: string | null;
  insertPosition: DrupalInsertPosition;

  /** Selector CSS del UNICO elemento cuyo enlace cambia `UPDATE_LINK_SOURCE`. */
  linkSelector: string | null;
  linkAttribute: DrupalLinkAttribute;

  /** Plantilla interpolable del nuevo valor (`{{llm_response.url}}`). */
  linkValueTemplate: string | null;
  attachmentNamespace: string;
  attachmentField: string;
  attachmentIndex: number;
  fileFieldName: string;

  /**
   * Sube el adjunto y lo enlaza dentro del bloque, en `APPEND_HTML_BLOCK`.
   *
   * Apagado por defecto: los cuatro params de adjunto ya traen valor, asi que
   * sin esta bandera cualquier APPEND sobre un correo con adjuntos empezaria a
   * escribir ficheros en Drupal sin que nadie lo hubiera pedido.
   */
  uploadAttachment: boolean;

  /** Lista, DENTRO del bloque insertado, que recibe el enlace al fichero. */
  attachmentListSelector: string;
}
