import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { OUTPUT_NAMESPACE_PATTERN } from '@core/fsm/types/pipeline-schema.types';

import { MAX_SELECTOR_LENGTH } from './template-mapper-config.dto';

/**
 * Modos operativos del nodo DESTINO_DRUPAL contra Drupal JSON:API.
 *
 * Son cinco trabajos distintos sobre el mismo CMS y no cinco variantes del
 * mismo: `CREATE_NODE` crea una entidad propia, los dos de bloques mutan el
 * `body.value` de una pagina AGREGADORA que acumula bloques,
 * `UPDATE_LINK_SOURCE` cambia un unico atributo `href`/`src` de esa misma
 * clase de pagina (Innodays) y `UPLOAD_ATTACHMENT` sube un binario. Un enum y
 * no un union type porque `@IsEnum()` necesita un objeto disponible en runtime.
 */
export enum DrupalOperationMode {
  CREATE_NODE = 'CREATE_NODE',
  APPEND_HTML_BLOCK = 'APPEND_HTML_BLOCK',
  TRANSFER_HTML_BLOCK = 'TRANSFER_HTML_BLOCK',
  UPDATE_LINK_SOURCE = 'UPDATE_LINK_SOURCE',
  UPLOAD_ATTACHMENT = 'UPLOAD_ATTACHMENT',
}

/** Atributo que reescribe `UPDATE_LINK_SOURCE`: el destino de un enlace o de una imagen. */
export type DrupalLinkAttribute = 'href' | 'src';

export const DRUPAL_LINK_ATTRIBUTES: readonly DrupalLinkAttribute[] = [
  'href',
  'src',
];

export const DEFAULT_DRUPAL_LINK_ATTRIBUTE: DrupalLinkAttribute = 'href';

/** Longitud maxima de la plantilla del nuevo enlace: una URL, no un texto. */
export const MAX_DRUPAL_LINK_TEMPLATE_LENGTH = 2048;

/**
 * Entorno por defecto del nodo: el de pruebas.
 *
 * Un nodo nuevo apunta al sandbox hasta que alguien lo cambie a conciencia:
 * equivocarse en ese sentido cuesta una prueba repetida, y en el contrario
 * cuesta publicar en el portal real.
 */
export const DEFAULT_DRUPAL_IS_SANDBOX = true;

/** Donde se inserta un bloque nuevo dentro del contenedor de la pagina. */
export type DrupalInsertPosition = 'PREPEND' | 'APPEND';

export const DRUPAL_INSERT_POSITIONS: readonly DrupalInsertPosition[] = [
  'PREPEND',
  'APPEND',
];

export const DEFAULT_DRUPAL_MODE = DrupalOperationMode.CREATE_NODE;

/**
 * Bundle destino, en la forma `entidad--bundle` de JSON:API.
 *
 * Es literalmente el miembro `data.type` del payload, y de el se deriva tambien
 * la ruta de coleccion (`node--noticias` -> `/node/noticias`). Un solo campo y
 * no dos (`entityType` + `bundle`) porque derivar ambos de la misma cadena hace
 * IMPOSIBLE que discrepen, y Drupal castiga esa discrepancia con un 409 cuyo
 * cuerpo no dice cual de los dos estaba mal.
 */
export const DEFAULT_DRUPAL_BUNDLE = 'node--noticias';

/**
 * Namespace del que se lee el markup a publicar.
 *
 * Es el `outputNamespace` canonico del `ESCUDO_POST_IA`, que es el nodo al que
 * este destino sigue por diseno: lo ultimo que toca el contenido antes de salir
 * del sistema.
 */
export const DEFAULT_DRUPAL_SOURCE_NAMESPACE = 'validated_drupal_json';

/**
 * Campo del que se lee el markup.
 *
 * `validated_markup` y NO `compiled_markup`. La diferencia no es cosmetica:
 * `compiled_markup` existe, pero en `rendered_html`, y desde el cambio de
 * semantica del MAPEADOR_PLANTILLA contiene la plantilla base SIN interpolar.
 * Apuntar ahi por defecto no fallaria —publicaria un articulo en blanco en
 * produccion, con 200 OK y sin alerta—, que es un desenlace peor que no
 * encontrar la clave. El defecto se elige por cual es el fallo mas barato.
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
 * `raw_email` y NO `parsed_email`, y esto es una restriccion dura del motor y
 * no una preferencia: `parsed_email.attachments` es un
 * `Omit<RawEmailAttachment, 'contentBase64'>` —el parser publica el INVENTARIO,
 * no los bytes, para no duplicar megabytes en la misma fila de
 * `contexto_acumulado`—, de modo que ahi no hay nada que subir.
 *
 * ADVERTENCIA TOPOLOGICA. Ni siquiera `raw_email` conserva los bytes para
 * siempre: `FsmEngineService` los libera en cuanto algun nodo publica texto de
 * PROCEDENCIA DOCUMENTAL (`extracted_documents_text`, `extracted_text`). El
 * cuerpo del correo ya NO cuenta —`clean_body` salio de `EXTRACTED_TEXT_KEYS`
 * precisamente porque purgaba adjuntos que nadie habia abierto—, pero un
 * `PARSER_PRE_IA` que extraiga el texto de los PDF si deja el inventario con
 * `contentBase64` a `null`.
 *
 * De ahi salen las dos unicas topologias que funcionan: un `UPLOAD_ATTACHMENT`
 * colocado ANTES del parser, o un `APPEND_HTML_BLOCK` con `uploadAttachment`
 * sobre un parser con `skipDocumentExtraction` encendido. En el resto de casos
 * no hay binario que subir, y el modo degrada con un aviso.
 */
export const DEFAULT_DRUPAL_ATTACHMENT_NAMESPACE = 'raw_email';

/** Clave del inventario de adjuntos dentro de ese namespace. */
export const DEFAULT_DRUPAL_ATTACHMENT_FIELD = 'attachments';

/** Primer adjunto del correo, que es el caso normal de una licitacion. */
export const DEFAULT_DRUPAL_ATTACHMENT_INDEX = 0;

/**
 * Tope del indice de adjunto.
 *
 * No protege de nada en ejecucion —si el indice no existe, el nodo falla con
 * `ERR_DRUPAL_MISSING_PAYLOAD` igual—, pero convierte un `999` tecleado por
 * error en un rechazo AL GUARDAR, con el nombre del param, en vez de en una
 * ejecucion pausada media hora despues.
 */
export const MAX_DRUPAL_ATTACHMENT_INDEX = 50;

/** Campo de fichero del nodo anfitrion al que se adjunta el binario. */
export const DEFAULT_DRUPAL_FILE_FIELD_NAME = 'field_adjuntos';

/**
 * Interruptor de la subida dentro de `APPEND_HTML_BLOCK`.
 *
 * Apagado por defecto, y es deliberado: los cuatro params de adjunto ya traen
 * valor, de modo que sin una bandera explicita no hay forma de distinguir
 * "configurado" de "sin configurar", y CUALQUIER `APPEND_HTML_BLOCK` sobre un
 * correo con adjuntos empezaria a escribir ficheros en Drupal sin que nadie lo
 * hubiera pedido. Un efecto externo no se enciende por omision.
 */
export const DEFAULT_DRUPAL_UPLOAD_ATTACHMENT = false;

/**
 * Lista del bloque donde se cuelga el enlace al fichero subido.
 *
 * Es un selector INTERNO al markup que se inserta, no de la pagina agregadora:
 * por eso no reutiliza `containerSelector`, que ya nombra el contenedor de
 * destino en el HTML remoto. El valor por defecto apunta a la lista que la
 * plantilla sembrada de licitaciones deja vacia a proposito (migracion 028).
 */
export const DEFAULT_DRUPAL_ATTACHMENT_LIST_SELECTOR = 'ul.licitacion-pliegos';

/** Tope del titulo: es el limite de `node.title` en Drupal estandar. */
export const MAX_DRUPAL_TITLE_LENGTH = 255;

/** Tope del resumen, generoso pero acotado para que quepa en una traza. */
export const MAX_DRUPAL_SUMMARY_LENGTH = 2000;

/** Tope de la plantilla del autor de una noticia. */
export const MAX_DRUPAL_AUTHOR_LENGTH = 255;

/**
 * Tope de la plantilla de la fecha. Holgado sobre los 10 caracteres de
 * `YYYY-MM-DD` porque lo que se guarda es la PLANTILLA (`{{ns.campo}}`), no la
 * fecha ya resuelta.
 */
export const MAX_DRUPAL_DATE_TEMPLATE_LENGTH = 128;

/** Orden de una noticia nueva en los listados de Drupal si no se configura otro. */
export const DEFAULT_DRUPAL_NEWS_ORDER = 1;

/** Tope del orden: holgado, pero evita un `99999999` tecleado por error. */
export const MAX_DRUPAL_NEWS_ORDER = 9999;

/**
 * Bundle de las noticias de Notiweb.
 *
 * Es el UNICO bundle que recibe `field_autor`, `field_fecha`, `field_orden` y
 * las tres taxonomias: enviarlos a otro bundle que no los declara provoca un 422.
 */
export const DRUPAL_NEWS_BUNDLE = 'node--noticias';

/**
 * `data.type` de JSON:API de cada vocabulario de las noticias, leido del esquema
 * real de `node--noticias` en Sandbox. Una relacion con el tipo equivocado la
 * rechaza Drupal aunque el UUID del termino sea correcto.
 */
export const DRUPAL_NEWS_TAXONOMY_TYPES = {
  field_fuente_noticia: 'taxonomy_term--fuente_noticia',
  field_noticia_seccion: 'taxonomy_term--tax_seccion',
  field_noticia_tipo: 'taxonomy_term--tax_tipos_noticia',
} as const;

/**
 * Forma de un `data.type` de JSON:API: `entidad--bundle`.
 *
 * Se exige el doble guion porque de el depende la derivacion de la ruta: sin el
 * separador no hay forma de saber donde acaba la entidad y empieza el bundle.
 */
export const DRUPAL_BUNDLE_PATTERN = /^[a-z0-9_]+--[a-z0-9_]+$/;

/**
 * Nombre de campo dentro de un namespace o de una entidad: snake_case.
 *
 * Misma gramatica que `OUTPUT_NAMESPACE_PATTERN` y por el mismo motivo: el par
 * namespace/campo acaba siendo la ruta de un `{{ns.campo}}`, cuya expresion de
 * sustitucion solo reconoce `[a-zA-Z0-9_]`.
 */
const FIELD_NAME_PATTERN = /^[a-z0-9_]+$/;

/** UUID v4, el identificador con el que JSON:API direcciona cada entidad. */
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Configuracion del nodo DESTINO_DRUPAL (publicacion en Drupal JSON:API).
 *
 * TODOS los campos son OPCIONALES, por la misma razon que en
 * `PostIaSanitizerConfigDto` y `WebScraperConfigDto`: una plantilla de flujo es
 * una topologia sin operativa y se guarda con `params: {}`, y
 * `PipelineValidatorService` aplica este mismo esquema a plantillas y a flujos
 * por igual. Lo que cada modo necesita de verdad para EJECUTARSE se declara en
 * `getIncompleteParams`, que es lo que consulta `assertActivatable`.
 *
 * NO declara `outputNamespace`. El namespace efectivo es el del NODO en el
 * `pipeline_schema`, que es el que lee `FsmEngineService` para depositar el
 * resultado; declararlo tambien aqui crearia una segunda fuente de verdad.
 */
export class DrupalHttpConfigDto {
  @ApiPropertyOptional({
    description:
      'Entorno del destino: true para las paginas de pruebas, false para las del portal. En el banco de pruebas se fuerza a true.',
    default: DEFAULT_DRUPAL_IS_SANDBOX,
  })
  @IsOptional()
  @IsBoolean({ message: 'isSandbox debe ser booleano.' })
  isSandbox?: boolean;

  @ApiPropertyOptional({
    description:
      'Modo operativo de publicacion o mutacion en Drupal. Por defecto CREATE_NODE.',
    enum: DrupalOperationMode,
    default: DEFAULT_DRUPAL_MODE,
  })
  @IsOptional()
  @IsEnum(DrupalOperationMode, {
    message: `operationMode debe ser uno de: ${Object.values(DrupalOperationMode).join(', ')}.`,
  })
  operationMode?: DrupalOperationMode;

  @ApiPropertyOptional({
    description:
      'Bundle destino en forma `entidad--bundle` (ej. node--noticias, node--page). Es el `data.type` de JSON:API y de el se deriva la ruta de coleccion.',
    default: DEFAULT_DRUPAL_BUNDLE,
    pattern: DRUPAL_BUNDLE_PATTERN.source,
  })
  @IsOptional()
  @IsString({ message: 'bundle debe ser una cadena.' })
  @Matches(DRUPAL_BUNDLE_PATTERN, {
    message:
      'bundle debe tener la forma `entidad--bundle` en minusculas (ej. "node--noticias").',
  })
  bundle?: string;

  @ApiPropertyOptional({
    description:
      'Namespace del que se lee el markup a publicar. El nodo NO escribe aqui.',
    default: DEFAULT_DRUPAL_SOURCE_NAMESPACE,
    pattern: OUTPUT_NAMESPACE_PATTERN.source,
  })
  @IsOptional()
  @IsString({ message: 'sourceNamespace debe ser una cadena.' })
  @Matches(OUTPUT_NAMESPACE_PATTERN, {
    message: 'sourceNamespace debe ser snake_case alfanumerico en minusculas.',
  })
  sourceNamespace?: string;

  @ApiPropertyOptional({
    description:
      'Campo del namespace de origen que contiene el markup. Por defecto `validated_markup`, que es lo que publica el ESCUDO_POST_IA.',
    default: DEFAULT_DRUPAL_SOURCE_FIELD,
    pattern: FIELD_NAME_PATTERN.source,
  })
  @IsOptional()
  @IsString({ message: 'sourceField debe ser una cadena.' })
  @Matches(FIELD_NAME_PATTERN, {
    message: 'sourceField debe ser snake_case alfanumerico en minusculas.',
  })
  sourceField?: string;

  @ApiPropertyOptional({
    description:
      'Plantilla interpolable del titulo de la entidad (ej. "{{llm_response.headline}}"). Obligatoria para ACTIVAR un CREATE_NODE.',
    example: '{{llm_response.headline}}',
  })
  // Es una PLANTILLA y no un par namespace/campo: el titular rara vez es un
  // campo pelado —suele llevar prefijo de seccion o fecha— y la maquinaria de
  // interpolacion del motor ya resuelve ambos casos. Las raices citadas aqui
  // las recoge `getRequiredNamespaces` con `extractNamespaceRoots`.
  @IsOptional()
  @IsString({ message: 'titleTemplate debe ser una cadena.' })
  @MaxLength(MAX_DRUPAL_TITLE_LENGTH, {
    message: `titleTemplate no puede superar ${MAX_DRUPAL_TITLE_LENGTH} caracteres.`,
  })
  titleTemplate?: string;

  @ApiPropertyOptional({
    description:
      'Plantilla interpolable del resumen. Viaja dentro del campo de texto largo (`body.summary`); si se omite, el resumen va a null.',
    example: '{{llm_response.summary}}',
  })
  // Va DENTRO del campo de cuerpo y no en un atributo propio: el bundle de
  // noticias no declara ningun campo de resumen, el cuerpo es un texto con
  // resumen. Un `field_resumen` suelto provocaba un 422 en cuanto se rellenaba.
  @IsOptional()
  @IsString({ message: 'summaryTemplate debe ser una cadena.' })
  @MaxLength(MAX_DRUPAL_SUMMARY_LENGTH, {
    message: `summaryTemplate no puede superar ${MAX_DRUPAL_SUMMARY_LENGTH} caracteres.`,
  })
  summaryTemplate?: string;

  @ApiPropertyOptional({
    description:
      'Plantilla interpolable del autor (`field_autor`). Solo se envia al bundle de noticias.',
    example: '{{llm_response.author}}',
  })
  @IsOptional()
  @IsString({ message: 'authorTemplate debe ser una cadena.' })
  @MaxLength(MAX_DRUPAL_AUTHOR_LENGTH, {
    message: `authorTemplate no puede superar ${MAX_DRUPAL_AUTHOR_LENGTH} caracteres.`,
  })
  authorTemplate?: string;

  @ApiPropertyOptional({
    description:
      'Plantilla interpolable de la fecha (`field_fecha`), que debe resolverse a `YYYY-MM-DD`. Solo se envia al bundle de noticias.',
    example: '{{parsed_email.date}}',
  })
  @IsOptional()
  @IsString({ message: 'dateTemplate debe ser una cadena.' })
  @MaxLength(MAX_DRUPAL_DATE_TEMPLATE_LENGTH, {
    message: `dateTemplate no puede superar ${MAX_DRUPAL_DATE_TEMPLATE_LENGTH} caracteres.`,
  })
  dateTemplate?: string;

  @ApiPropertyOptional({
    description:
      'Orden de la noticia en los listados (`field_orden`). Solo se envia al bundle de noticias.',
    default: DEFAULT_DRUPAL_NEWS_ORDER,
    minimum: 0,
    maximum: MAX_DRUPAL_NEWS_ORDER,
  })
  @IsOptional()
  @IsInt({ message: 'orderValue debe ser un numero entero.' })
  @Min(0, { message: 'orderValue no puede ser negativo.' })
  @Max(MAX_DRUPAL_NEWS_ORDER, {
    message: `orderValue no puede superar ${MAX_DRUPAL_NEWS_ORDER}.`,
  })
  orderValue?: number;

  @ApiPropertyOptional({
    description:
      'UUID v4 del termino de la taxonomia de fuente (`field_fuente_noticia`). Si se omite, la relacion no viaja.',
  })
  @IsOptional()
  @IsString({ message: 'newsSourceTermUuid debe ser una cadena.' })
  @Matches(UUID_V4_PATTERN, {
    message: 'newsSourceTermUuid debe ser un UUID v4 valido.',
  })
  newsSourceTermUuid?: string;

  @ApiPropertyOptional({
    description:
      'UUID v4 del termino de la taxonomia de seccion (`field_noticia_seccion`). Si se omite, la relacion no viaja.',
  })
  @IsOptional()
  @IsString({ message: 'newsSectionTermUuid debe ser una cadena.' })
  @Matches(UUID_V4_PATTERN, {
    message: 'newsSectionTermUuid debe ser un UUID v4 valido.',
  })
  newsSectionTermUuid?: string;

  @ApiPropertyOptional({
    description:
      'UUID v4 del termino de la taxonomia de tipo (`field_noticia_tipo`). Si se omite, la relacion no viaja.',
  })
  @IsOptional()
  @IsString({ message: 'newsTypeTermUuid debe ser una cadena.' })
  @Matches(UUID_V4_PATTERN, {
    message: 'newsTypeTermUuid debe ser un UUID v4 valido.',
  })
  newsTypeTermUuid?: string;

  @ApiPropertyOptional({
    description: 'Campo de texto largo de la entidad.',
    default: DEFAULT_DRUPAL_BODY_FIELD,
    pattern: FIELD_NAME_PATTERN.source,
  })
  @IsOptional()
  @IsString({ message: 'bodyFieldName debe ser una cadena.' })
  @Matches(FIELD_NAME_PATTERN, {
    message: 'bodyFieldName debe ser snake_case alfanumerico en minusculas.',
  })
  bodyFieldName?: string;

  @ApiPropertyOptional({
    description: 'Formato de texto con el que Drupal renderiza el markup.',
    default: DEFAULT_DRUPAL_BODY_FORMAT,
    pattern: FIELD_NAME_PATTERN.source,
  })
  @IsOptional()
  @IsString({ message: 'bodyFormat debe ser una cadena.' })
  @Matches(FIELD_NAME_PATTERN, {
    message: 'bodyFormat debe ser snake_case alfanumerico en minusculas.',
  })
  bodyFormat?: string;

  @ApiPropertyOptional({
    description: 'Publicar la entidad al crearla (`status`).',
    default: true,
  })
  @IsOptional()
  @IsBoolean({ message: 'publishStatus debe ser booleano.' })
  publishStatus?: boolean;

  @ApiPropertyOptional({
    description:
      'UUID v4 del nodo a mutar: la pagina agregadora en APPEND/TRANSFER, o el nodo anfitrion en UPLOAD_ATTACHMENT.',
  })
  @IsOptional()
  @IsString({ message: 'targetNodeUuid debe ser una cadena.' })
  @Matches(UUID_V4_PATTERN, {
    message: 'targetNodeUuid debe ser un UUID v4 valido.',
  })
  targetNodeUuid?: string;

  @ApiPropertyOptional({
    description:
      'UUID v4 de la pagina receptora del bloque en TRANSFER_HTML_BLOCK (la de licitaciones cerradas).',
  })
  @IsOptional()
  @IsString({ message: 'destinationNodeUuid debe ser una cadena.' })
  @Matches(UUID_V4_PATTERN, {
    message: 'destinationNodeUuid debe ser un UUID v4 valido.',
  })
  destinationNodeUuid?: string;

  @ApiPropertyOptional({
    description:
      'Selector CSS del contenedor dentro del cual se inserta el bloque. Si se omite, se inserta en la raiz del fragmento.',
    example: 'div.listado-licitaciones',
  })
  @IsOptional()
  @IsString({ message: 'containerSelector debe ser una cadena.' })
  @MaxLength(MAX_SELECTOR_LENGTH, {
    message: `containerSelector no puede superar ${MAX_SELECTOR_LENGTH} caracteres.`,
  })
  containerSelector?: string;

  @ApiPropertyOptional({
    description:
      'Selector CSS que aisla el bloque a trasladar en TRANSFER_HTML_BLOCK (ej. `[data-expediente="S_2026_015"]`).',
    example: '[data-expediente="S_2026_015"]',
  })
  @IsOptional()
  @IsString({ message: 'itemSelector debe ser una cadena.' })
  @MaxLength(MAX_SELECTOR_LENGTH, {
    message: `itemSelector no puede superar ${MAX_SELECTOR_LENGTH} caracteres.`,
  })
  itemSelector?: string;

  @ApiPropertyOptional({
    description:
      'Selector CSS del contenedor de la pagina DESTINO donde se inserta el bloque en TRANSFER_HTML_BLOCK (ej. `#collapse2 > .panel-body`). Si se omite, se usa `containerSelector`.',
    example: '#collapse2 > .panel-body',
  })
  // Campo propio y no `containerSelector`: en un traslado hay DOS paginas, y el
  // contenedor que importa es el de la receptora, que no tiene por que llamarse
  // igual que el de la pagina de origen.
  @IsOptional()
  @IsString({ message: 'targetContainerSelector debe ser una cadena.' })
  @MaxLength(MAX_SELECTOR_LENGTH, {
    message: `targetContainerSelector no puede superar ${MAX_SELECTOR_LENGTH} caracteres.`,
  })
  targetContainerSelector?: string;

  @ApiPropertyOptional({
    description: 'Donde insertar el bloque dentro del contenedor.',
    enum: DRUPAL_INSERT_POSITIONS,
    default: DEFAULT_DRUPAL_INSERT_POSITION,
  })
  @IsOptional()
  @IsIn(DRUPAL_INSERT_POSITIONS, {
    message: 'insertPosition debe ser PREPEND o APPEND.',
  })
  insertPosition?: DrupalInsertPosition;

  @ApiPropertyOptional({
    description:
      'Plantilla interpolable del codigo de expediente con el que se envuelve una licitacion nueva en APPEND_HTML_BLOCK (`div.pd-licitacion-block[data-expediente]`). Solo se usa si el marcado no trae ya su propio `data-expediente`.',
    example: '{{llm_response.expediente}}',
  })
  @IsOptional()
  @IsString({ message: 'expedienteTemplate debe ser una cadena.' })
  @MaxLength(MAX_SELECTOR_LENGTH, {
    message: `expedienteTemplate no puede superar ${MAX_SELECTOR_LENGTH} caracteres.`,
  })
  expedienteTemplate?: string;

  @ApiPropertyOptional({
    description:
      "Selector CSS del UNICO elemento cuyo enlace se actualiza en UPDATE_LINK_SOURCE (ej. `table tr:contains('{{ns.evento_nombre}}') a`). Interpolable: cada valor se escapa antes de entrar en el selector.",
    example: "table tr:contains('Agrifood') a",
  })
  @IsOptional()
  @IsString({ message: 'linkSelector debe ser una cadena.' })
  @MaxLength(MAX_SELECTOR_LENGTH, {
    message: `linkSelector no puede superar ${MAX_SELECTOR_LENGTH} caracteres.`,
  })
  linkSelector?: string;

  @ApiPropertyOptional({
    description: 'Atributo que se reescribe en UPDATE_LINK_SOURCE.',
    enum: DRUPAL_LINK_ATTRIBUTES,
    default: DEFAULT_DRUPAL_LINK_ATTRIBUTE,
  })
  @IsOptional()
  @IsIn(DRUPAL_LINK_ATTRIBUTES, {
    message: 'linkAttribute debe ser href o src.',
  })
  linkAttribute?: DrupalLinkAttribute;

  @ApiPropertyOptional({
    description:
      'Plantilla interpolable del nuevo valor del atributo en UPDATE_LINK_SOURCE (ej. "{{llm_response.url}}").',
    example: '{{llm_response.url}}',
  })
  @IsOptional()
  @IsString({ message: 'linkValueTemplate debe ser una cadena.' })
  @MaxLength(MAX_DRUPAL_LINK_TEMPLATE_LENGTH, {
    message: `linkValueTemplate no puede superar ${MAX_DRUPAL_LINK_TEMPLATE_LENGTH} caracteres.`,
  })
  linkValueTemplate?: string;

  @ApiPropertyOptional({
    description:
      'Namespace del que sale el binario del adjunto. Por defecto `raw_email`: es el UNICO que lleva `contentBase64` (`parsed_email` publica el inventario sin bytes).',
    default: DEFAULT_DRUPAL_ATTACHMENT_NAMESPACE,
    pattern: OUTPUT_NAMESPACE_PATTERN.source,
  })
  @IsOptional()
  @IsString({ message: 'attachmentNamespace debe ser una cadena.' })
  @Matches(OUTPUT_NAMESPACE_PATTERN, {
    message:
      'attachmentNamespace debe ser snake_case alfanumerico en minusculas.',
  })
  attachmentNamespace?: string;

  @ApiPropertyOptional({
    description: 'Clave del inventario de adjuntos dentro de ese namespace.',
    default: DEFAULT_DRUPAL_ATTACHMENT_FIELD,
    pattern: FIELD_NAME_PATTERN.source,
  })
  @IsOptional()
  @IsString({ message: 'attachmentField debe ser una cadena.' })
  @Matches(FIELD_NAME_PATTERN, {
    message: 'attachmentField debe ser snake_case alfanumerico en minusculas.',
  })
  attachmentField?: string;

  @ApiPropertyOptional({
    description: 'Indice del adjunto a subir dentro del inventario.',
    default: DEFAULT_DRUPAL_ATTACHMENT_INDEX,
    minimum: 0,
    maximum: MAX_DRUPAL_ATTACHMENT_INDEX,
  })
  @IsOptional()
  @IsInt({ message: 'attachmentIndex debe ser un numero entero.' })
  @Min(0, { message: 'attachmentIndex no puede ser negativo.' })
  @Max(MAX_DRUPAL_ATTACHMENT_INDEX, {
    message: `attachmentIndex no puede superar ${MAX_DRUPAL_ATTACHMENT_INDEX}.`,
  })
  attachmentIndex?: number;

  @ApiPropertyOptional({
    description:
      'Campo de fichero del nodo anfitrion al que se adjunta el binario.',
    default: DEFAULT_DRUPAL_FILE_FIELD_NAME,
    pattern: FIELD_NAME_PATTERN.source,
  })
  @IsOptional()
  @IsString({ message: 'fileFieldName debe ser una cadena.' })
  @Matches(FIELD_NAME_PATTERN, {
    message: 'fileFieldName debe ser snake_case alfanumerico en minusculas.',
  })
  fileFieldName?: string;

  @ApiPropertyOptional({
    description:
      'Sube el adjunto y enlaza el fichero dentro del bloque, en APPEND_HTML_BLOCK.',
    default: DEFAULT_DRUPAL_UPLOAD_ATTACHMENT,
  })
  @IsOptional()
  @IsBoolean({ message: 'uploadAttachment debe ser un booleano.' })
  uploadAttachment?: boolean;

  @ApiPropertyOptional({
    description:
      'Selector, DENTRO del bloque insertado, de la lista que recibe el enlace al fichero.',
    default: DEFAULT_DRUPAL_ATTACHMENT_LIST_SELECTOR,
    maxLength: MAX_SELECTOR_LENGTH,
  })
  @IsOptional()
  @IsString({ message: 'attachmentListSelector debe ser una cadena.' })
  @MaxLength(MAX_SELECTOR_LENGTH, {
    message: `attachmentListSelector no puede superar ${MAX_SELECTOR_LENGTH} caracteres.`,
  })
  attachmentListSelector?: string;
}

/** Configuracion del destino Drupal con los valores por defecto ya aplicados. */
export interface ResolvedDrupalHttpConfig {
  readonly isSandbox: boolean;
  readonly operationMode: DrupalOperationMode;
  readonly bundle: string;
  readonly sourceNamespace: string;
  readonly sourceField: string;
  readonly titleTemplate: string | null;
  readonly summaryTemplate: string | null;
  readonly authorTemplate: string | null;
  readonly dateTemplate: string | null;
  readonly orderValue: number;
  readonly newsSourceTermUuid: string | null;
  readonly newsSectionTermUuid: string | null;
  readonly newsTypeTermUuid: string | null;
  readonly bodyFieldName: string;
  readonly bodyFormat: string;
  readonly publishStatus: boolean;
  readonly targetNodeUuid: string | null;
  readonly destinationNodeUuid: string | null;
  readonly containerSelector: string | null;
  readonly itemSelector: string | null;
  readonly targetContainerSelector: string | null;
  readonly insertPosition: DrupalInsertPosition;
  readonly expedienteTemplate: string | null;
  readonly linkSelector: string | null;
  readonly linkAttribute: DrupalLinkAttribute;
  readonly linkValueTemplate: string | null;
  readonly attachmentNamespace: string;
  readonly attachmentField: string;
  readonly attachmentIndex: number;
  readonly fileFieldName: string;
  readonly uploadAttachment: boolean;
  readonly attachmentListSelector: string;
}

/** Cadena no vacia, o `null`. Evita que un `"  "` pase por valor declarado. */
const trimmedOrNull = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? '';

  return trimmed.length === 0 ? null : trimmed;
};

/**
 * Aplica los valores por defecto sobre un DTO ya validado. Funcion pura.
 *
 * Los defectos se resuelven aqui con `??` y NO con un inicializador de
 * propiedad en la clase: `plainToInstance` no corre con `exposeDefaultValues`,
 * asi que un inicializador no actuaria nunca (ver `imap-trigger-config.dto.ts`).
 *
 * Los opcionales sin defecto caen a `null` y no a `undefined`: con
 * `exactOptionalPropertyTypes`, un `string | undefined` produce una propiedad
 * que puede FALTAR, y el consumidor tendria que distinguir dos formas de
 * ausencia que significan lo mismo.
 */
export const resolveDrupalHttpConfig = (
  dto: DrupalHttpConfigDto,
): ResolvedDrupalHttpConfig => ({
  isSandbox: dto.isSandbox ?? DEFAULT_DRUPAL_IS_SANDBOX,
  operationMode: dto.operationMode ?? DEFAULT_DRUPAL_MODE,
  bundle: trimmedOrNull(dto.bundle) ?? DEFAULT_DRUPAL_BUNDLE,
  sourceNamespace:
    trimmedOrNull(dto.sourceNamespace) ?? DEFAULT_DRUPAL_SOURCE_NAMESPACE,
  sourceField: trimmedOrNull(dto.sourceField) ?? DEFAULT_DRUPAL_SOURCE_FIELD,
  titleTemplate: trimmedOrNull(dto.titleTemplate),
  summaryTemplate: trimmedOrNull(dto.summaryTemplate),
  authorTemplate: trimmedOrNull(dto.authorTemplate),
  dateTemplate: trimmedOrNull(dto.dateTemplate),
  orderValue: dto.orderValue ?? DEFAULT_DRUPAL_NEWS_ORDER,
  newsSourceTermUuid: trimmedOrNull(dto.newsSourceTermUuid),
  newsSectionTermUuid: trimmedOrNull(dto.newsSectionTermUuid),
  newsTypeTermUuid: trimmedOrNull(dto.newsTypeTermUuid),
  bodyFieldName: trimmedOrNull(dto.bodyFieldName) ?? DEFAULT_DRUPAL_BODY_FIELD,
  bodyFormat: trimmedOrNull(dto.bodyFormat) ?? DEFAULT_DRUPAL_BODY_FORMAT,
  publishStatus: dto.publishStatus ?? true,
  targetNodeUuid: trimmedOrNull(dto.targetNodeUuid),
  destinationNodeUuid: trimmedOrNull(dto.destinationNodeUuid),
  containerSelector: trimmedOrNull(dto.containerSelector),
  itemSelector: trimmedOrNull(dto.itemSelector),
  targetContainerSelector: trimmedOrNull(dto.targetContainerSelector),
  insertPosition: dto.insertPosition ?? DEFAULT_DRUPAL_INSERT_POSITION,
  expedienteTemplate: trimmedOrNull(dto.expedienteTemplate),
  linkSelector: trimmedOrNull(dto.linkSelector),
  linkAttribute: dto.linkAttribute ?? DEFAULT_DRUPAL_LINK_ATTRIBUTE,
  linkValueTemplate: trimmedOrNull(dto.linkValueTemplate),
  attachmentNamespace:
    trimmedOrNull(dto.attachmentNamespace) ??
    DEFAULT_DRUPAL_ATTACHMENT_NAMESPACE,
  attachmentField:
    trimmedOrNull(dto.attachmentField) ?? DEFAULT_DRUPAL_ATTACHMENT_FIELD,
  attachmentIndex: dto.attachmentIndex ?? DEFAULT_DRUPAL_ATTACHMENT_INDEX,
  fileFieldName:
    trimmedOrNull(dto.fileFieldName) ?? DEFAULT_DRUPAL_FILE_FIELD_NAME,
  uploadAttachment: dto.uploadAttachment ?? DEFAULT_DRUPAL_UPLOAD_ATTACHMENT,
  attachmentListSelector:
    trimmedOrNull(dto.attachmentListSelector) ??
    DEFAULT_DRUPAL_ATTACHMENT_LIST_SELECTOR,
});
