// Replica del contrato de `DrupalHttpConfigDto` (backend). Cualquier cambio
// alla debe reflejarse aqui.
//
// El DTO se valida con `{ whitelist: true, forbidNonWhitelisted: true }`: una
// clave que no figure alli es un 400 al guardar el flujo, no un campo ignorado.
// Por eso esta replica enumera EXACTAMENTE los 18 params y ni uno mas.

/**
 * Modos operativos del nodo contra Drupal JSON:API.
 *
 * Son cuatro trabajos distintos sobre el mismo CMS y no cuatro variantes del
 * mismo, de ahi que cada uno pida sus propios campos: `CREATE_NODE` crea una
 * entidad propia, los dos de HTML mutan el `body.value` de una pagina
 * AGREGADORA que acumula bloques, y `UPLOAD_ATTACHMENT` sube un binario.
 */
export enum DrupalOperationMode {
  CREATE_NODE = 'CREATE_NODE',
  APPEND_HTML_BLOCK = 'APPEND_HTML_BLOCK',
  TRANSFER_HTML_BLOCK = 'TRANSFER_HTML_BLOCK',
  UPLOAD_ATTACHMENT = 'UPLOAD_ATTACHMENT',
}

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
 * Un destino operativo completo, para los botones de carga rapida.
 *
 * Declara TODO lo que el modo elegido necesita, y no solo el identificador: un
 * `TRANSFER_HTML_BLOCK` sin `itemSelector` o un `APPEND_HTML_BLOCK` sin bundle
 * no son configuraciones a medias, son configuraciones que fallan en ejecucion.
 */
export interface DrupalSandboxPreset {
  /** Rotulo del boton. Corto: va dentro de un `q-btn` en una fila de tres. */
  readonly label: string;

  /** Que hace este destino, para el `q-tooltip`. */
  readonly description: string;

  /** Identificador interno del nodo en Drupal. Informativo: la API usa el UUID. */
  readonly nid: number;

  readonly operationMode: DrupalOperationMode;
  readonly bundle: string;

  /**
   * Pagina o entidad sobre la que actua el destino.
   *
   * `null` en los presets que dan de alta contenido nuevo sin colgarlo de una
   * pagina conocida. Sembrar aqui un UUID inventado para «dejarlo relleno»
   * seria el peor de los rellenos: el patron v4 casaria, el paso quedaria
   * valido y el fallo saldria en ejecucion como un 404 con el flujo ya
   * PAUSADO. Nulo, `isConfigValid` lo reclama en el momento de configurar.
   */
  readonly targetNodeUuid: string | null;

  /**
   * Pagina receptora en `TRANSFER_HTML_BLOCK`.
   *
   * `null` significa «lo pone el operador», y en el unico preset de traslado lo
   * es a proposito: la pagina de licitaciones CERRADAS aun no tiene UUID
   * conocido. Apuntarlo a la misma pagina de origen para «poder probar» seria
   * destructivo —`runTransferHtmlBlock` lee origen y destino por separado y el
   * segundo PATCH pisa al primero con un DOM ya obsoleto, de modo que el bloque
   * se borra sin dejar copia y el nodo devuelve exito—. Dejandolo nulo, el paso
   * queda invalido hasta que alguien escriba el destino de verdad.
   */
  readonly destinationNodeUuid: string | null;

  readonly containerSelector: string | null;
  readonly itemSelector: string | null;
  readonly insertPosition: DrupalInsertPosition;

  /**
   * Plantilla de `plantillas_html` que acompana a este destino.
   *
   * Es una PISTA para el operador —se muestra en el tooltip—, no una clave
   * ajena: nada la resuelve ni la valida. El nodo que elige plantilla es el
   * MAPEADOR_PLANTILLA, varios pasos antes, y un store de nodo no puede leer el
   * de otro (`frontend-quasar.md` §3.1). Se identifica por NOMBRE porque
   * `plantillas_html` no tiene columna `codigo`: su unica clave estable, aparte
   * del UUID que cambia en cada instalacion, es el nombre con indice unico.
   */
  readonly associatedTemplateName: string | null;
}

/**
 * Destinos operativos confirmados en el Drupal de Madrid+D.
 *
 * Son UUID publicos de dos paginas de sandbox, no credenciales: viajan en el
 * bundle sin exponer nada. El token (`DRUPAL_API_TOKEN`) vive exclusivamente en
 * `backend/.env` y jamas llega al cliente (`security-and-scope.md` §0.1).
 *
 * Existen porque teclear un UUID v4 a mano es el error mas caro de este
 * formulario: un digito cambiado no se detecta al guardar —el patron sigue
 * casando— sino en ejecucion, con un 404 de Drupal y el flujo ya PAUSADO.
 */
export const DRUPAL_SANDBOX_PRESETS: Readonly<
  Record<
    'ABRIR_LICITACION' | 'CERRAR_LICITACION' | 'VERIFICACION_TITULOS' | 'NOTIWEB',
    DrupalSandboxPreset
  >
> = {
  ABRIR_LICITACION: {
    label: 'Abrir licitación',
    description:
      'Antepone el bloque de la convocatoria a la página agregadora de licitaciones abiertas.',
    nid: 55937,
    operationMode: DrupalOperationMode.APPEND_HTML_BLOCK,
    bundle: 'node--page',
    targetNodeUuid: '7f1700bf-b54b-4c12-b71a-8a71f1f0ee38',
    destinationNodeUuid: null,
    // Panel desplegable de "convocatorias abiertas" en la pagina agregadora.
    // Sin el, el bloque se antepondria al cuerpo entero del nodo y quedaria
    // fuera del acordeon que el portal presenta.
    containerSelector: '#collapse2 > .panel-body',
    itemSelector: null,
    // Lo ultimo convocado se lee arriba, que es como el portal presenta la lista.
    insertPosition: 'PREPEND',
    associatedTemplateName: 'Licitaciones · Convocatoria abierta (Madrid+D)',
  },
  CERRAR_LICITACION: {
    label: 'Cerrar licitación',
    description:
      'Traslada un bloque de licitación desde la página de abiertas a la de cerradas. Exige indicar a mano la página de destino.',
    nid: 55937,
    operationMode: DrupalOperationMode.TRANSFER_HTML_BLOCK,
    bundle: 'node--page',
    targetNodeUuid: '7f1700bf-b54b-4c12-b71a-8a71f1f0ee38',
    // Ver el TSDoc del campo: queda nulo a proposito.
    destinationNodeUuid: null,
    containerSelector: null,
    // La clase del envoltorio que siembra la plantilla de apertura. Afinarla a
    // un expediente concreto (`[data-expediente="..."]`) es trabajo del flujo.
    itemSelector: '.licitacion-entry',
    // En cerradas el orden cronologico se lee al reves: lo ultimo en cerrarse va
    // al final, detras de lo que lleva mas tiempo archivado.
    insertPosition: 'APPEND',
    associatedTemplateName: 'Licitaciones · Convocatoria cerrada (Madrid+D)',
  },
  VERIFICACION_TITULOS: {
    label: 'Verificación de títulos',
    description:
      'Antepone el panel colapsable del comité dentro del acordeón de la página agregadora.',
    nid: 55938,
    // APPEND_HTML_BLOCK y ya no CREATE_NODE. El canal daba de alta una entidad
    // por panel, pero lo que el portal presenta en
    // `/prueba-verificador-titulos` es un ACORDEON: cada comite es un panel
    // colapsable DENTRO del HTML de la pagina agregadora, no un nodo suelto.
    // Dar de alta la entidad publicaba un contenido que nadie llegaba a ver
    // desde la pagina que lo agrega.
    operationMode: DrupalOperationMode.APPEND_HTML_BLOCK,
    bundle: 'node--page',
    targetNodeUuid: 'b17d69d8-6998-4883-b8dc-153b55dbd9c5',
    destinationNodeUuid: null,
    // Acordeon RAIZ del portal, y es un RESPALDO, no el destino.
    //
    // El destino real lo decide cada panel por su `data-parent`, y la estrategia
    // lo reparte al sub-acordeon de su universidad. Este selector solo entra en
    // juego con marcado que no declara destino ninguno.
    //
    // Estuvo en `#accordionCEU`, que era el acordeon de UNA universidad
    // concreta: un panel sin destino resoluble acababa publicado dentro de CEU,
    // que es un error bastante mas dificil de ver que dejarlo en la raiz.
    containerSelector: '#accordion',
    // El envoltorio que siembra la plantilla base, equivalente a
    // `.licitacion-entry` en el canal de licitaciones. Afinarlo a un comite
    // concreto (`[data-comite="CEU1"]`) es trabajo del flujo.
    itemSelector: '.panel-default',
    // Lo ultimo convocado se lee arriba, como el portal presenta la lista.
    insertPosition: 'PREPEND',
    associatedTemplateName: 'Verificación de Títulos · Panel de evaluación',
  },
  NOTIWEB: {
    label: 'Notiweb',
    description:
      'Da de alta una noticia individual de Notiweb. No cuelga de ninguna pagina agregadora: cada publicacion es su propio nodo.',
    // Sin pagina receptora: este canal crea entidades sueltas. Se deja el nid
    // del agregador de licitaciones fuera a proposito y se marca con 0, que es
    // el valor que dice "no aplica" sin inventar un identificador.
    nid: 0,
    operationMode: DrupalOperationMode.CREATE_NODE,
    bundle: 'node--noticias',
    // El operador lo escribe: no hay una entidad fija a la que apuntar.
    targetNodeUuid: null,
    destinationNodeUuid: null,
    containerSelector: null,
    itemSelector: null,
    insertPosition: 'PREPEND',
    associatedTemplateName: 'Notiweb · Noticia institucional',
  },
};

/** Claves de `DRUPAL_SANDBOX_PRESETS`, para tipar el selector sin `string`. */
export type DrupalSandboxPresetKey = keyof typeof DRUPAL_SANDBOX_PRESETS;

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
