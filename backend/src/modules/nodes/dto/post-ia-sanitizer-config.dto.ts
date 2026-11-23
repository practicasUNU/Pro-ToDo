import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import { OUTPUT_NAMESPACE_PATTERN } from '@core/fsm/types/pipeline-schema.types';

import {
  MAX_ALLOWED_TAGS,
  MAX_REQUIRED_SELECTORS,
  MAX_SELECTOR_LENGTH,
} from './template-mapper-config.dto';

/**
 * Namespace del que se lee la respuesta del modelo, si el nodo no declara otro.
 *
 * Es el `outputNamespace` canonico de `PROCESADOR_IA`, que es el nodo al que
 * este escudo sigue por diseno.
 */
export const DEFAULT_POST_IA_SOURCE_NAMESPACE = 'llm_response';

/**
 * Campo del que se lee el markup, si el nodo no declara otro.
 *
 * `LlmExtractorStrategy` lo publica cuando su prompt cita
 * `{{rendered_html.compiled_markup}}` (flujos con plantilla, como Notiweb o
 * Abrir licitacion). Sin plantilla vale `null`, y para esos flujos —Cerrar
 * licitacion, Innodays, Innobar— esta `contentMode: 'TEXT'`.
 *
 * Se llama `filled_markup` y no `compiled_markup` para no colisionar con
 * `rendered_html.compiled_markup`, que es la plantilla base VACIA. Dos
 * namespaces con la misma clave y contenidos opuestos convierten cualquier traza
 * de ejecucion en un acertijo.
 */
export const DEFAULT_POST_IA_SOURCE_FIELD = 'filled_markup';

/**
 * Nombre de campo dentro de un namespace: `snake_case` alfanumerico.
 *
 * Misma gramatica que `OUTPUT_NAMESPACE_PATTERN` y por el mismo motivo: el par
 * namespace/campo acaba siendo la ruta de un `{{ns.campo}}`, cuya expresion de
 * sustitucion solo reconoce `[a-zA-Z0-9_]`. Un campo con guiones o puntos seria
 * ilegible para el motor aunque el payload lo trajera.
 */
const SOURCE_FIELD_PATTERN = /^[a-z0-9_]+$/;

/**
 * Que audita el escudo.
 *
 * - `HTML`: un campo con markup (por defecto `filled_markup`), saneado con la
 *   lista blanca y auditado por selectores. Es el modo historico.
 * - `TEXT`: varios campos de TEXTO del modelo (`headline`, `summary`...),
 *   despojados de TODA etiqueta. Es el que permite poner el escudo detras de un
 *   `PROCESADOR_IA` sin `MAPEADOR_PLANTILLA`, en los flujos que no maquetan.
 */
export enum PostIaContentMode {
  HTML = 'HTML',
  TEXT = 'TEXT',
}

export const DEFAULT_POST_IA_CONTENT_MODE = PostIaContentMode.HTML;

/** Campos que se auditan en modo TEXT si el nodo no declara otros. */
export const DEFAULT_POST_IA_SOURCE_FIELDS: readonly string[] = [
  'headline',
  'summary',
];

/** Techo de campos en modo TEXT. */
export const MAX_POST_IA_SOURCE_FIELDS = 20;

/** Nombre de etiqueta HTML en minusculas, tal y como lo escribe el saneador. */
const HTML_TAG_PATTERN = /^[a-z][a-z0-9]*$/;

/**
 * Configuracion del nodo `ESCUDO_POST_IA`.
 *
 * El nodo es la barrera entre la inferencia y la publicacion: poda las vallas
 * markdown que el modelo anade por su cuenta, rechaza las interpolaciones que
 * dejo sin resolver, sanea contra XSS con la lista blanca COMPARTIDA del gestor
 * de plantillas y audita que las ranuras estructurales del flujo sigan ahi y
 * vengan rellenas.
 *
 * Todos los campos son OPCIONALES, por la misma razon que en
 * `TemplateMapperConfigDto` y `WebScraperConfigDto`: una plantilla de flujo es
 * una topologia sin operativa y se guarda con `params: {}`, y
 * `PipelineValidatorService` aplica este mismo esquema a plantillas y flujos por
 * igual. Aqui ademas los dos campos de origen tienen defecto util, asi que un
 * escudo sin configurar es un nodo que funciona, no uno a medias: no hay nada
 * que declarar en `getIncompleteParams`.
 *
 * NO declara `outputNamespace`. El namespace efectivo es el del NODO en el
 * `pipeline_schema`, que es el que lee `FsmEngineService` para depositar el
 * resultado; declararlo tambien aqui crearia la segunda fuente de verdad que
 * `llm-extractor-config.dto.ts` prohibe por escrito. A diferencia del mapeador,
 * este tipo de nodo no tiene esquemas historicos con el campo dentro de `params`
 * —nunca tuvo estrategia que los ejecutara—, asi que no hay nada que tolerar.
 */
export class PostIaSanitizerConfigDto {
  @ApiPropertyOptional({
    description:
      'Namespace del que se lee la respuesta del modelo. El nodo NO escribe aqui: su salida va al `outputNamespace` declarado para el nodo en el pipeline_schema.',
    default: DEFAULT_POST_IA_SOURCE_NAMESPACE,
    pattern: OUTPUT_NAMESPACE_PATTERN.source,
  })
  @IsOptional()
  @IsString({ message: 'sourceNamespace debe ser una cadena.' })
  @Matches(OUTPUT_NAMESPACE_PATTERN, {
    message: 'sourceNamespace debe ser snake_case alfanumerico en minusculas.',
  })
  sourceNamespace?: string;

  @ApiPropertyOptional({
    enum: PostIaContentMode,
    default: DEFAULT_POST_IA_CONTENT_MODE,
    description:
      'HTML audita un campo de markup; TEXT audita varios campos de texto plano (sin MAPEADOR_PLANTILLA delante).',
  })
  @IsOptional()
  @IsEnum(PostIaContentMode, {
    message: `contentMode debe ser uno de: ${Object.values(PostIaContentMode).join(', ')}.`,
  })
  contentMode?: PostIaContentMode;

  @ApiPropertyOptional({
    description:
      'Solo en modo TEXT: campos del namespace de origen que se auditan como texto plano.',
    type: [String],
    default: DEFAULT_POST_IA_SOURCE_FIELDS,
  })
  @IsOptional()
  @IsArray({ message: 'sourceFields debe ser un arreglo.' })
  @ArrayMaxSize(MAX_POST_IA_SOURCE_FIELDS, {
    message: `sourceFields no puede declarar mas de ${MAX_POST_IA_SOURCE_FIELDS} campos.`,
  })
  @IsString({ each: true, message: 'Cada campo debe ser una cadena.' })
  @Matches(SOURCE_FIELD_PATTERN, {
    each: true,
    message: 'Cada campo de sourceFields debe ser snake_case alfanumerico.',
  })
  sourceFields?: string[];

  @ApiPropertyOptional({
    description:
      'Modo HTML: campo del namespace de origen que contiene el HTML a auditar (lo publica el PROCESADOR_IA cuando rellena una plantilla).',
    default: DEFAULT_POST_IA_SOURCE_FIELD,
    pattern: SOURCE_FIELD_PATTERN.source,
  })
  @IsOptional()
  @IsString({ message: 'sourceField debe ser una cadena.' })
  @Matches(SOURCE_FIELD_PATTERN, {
    message: 'sourceField debe ser snake_case alfanumerico en minusculas.',
  })
  sourceField?: string;

  @ApiPropertyOptional({
    description: `Selectores CSS que el HTML devuelto por la IA DEBE conservar y traer rellenos (ej. "h1.titular"). Hasta ${MAX_REQUIRED_SELECTORS}.`,
    type: [String],
    example: ['h1.titular', 'div.cuerpo'],
  })
  // Es el contrato estructural del nodo, y la contrapartida exacta del
  // `requiredSelectors` del MAPEADOR_PLANTILLA: alli se comprueba que la ranura
  // EXISTE en la plantilla base, y aqui que la IA no se la llevo por delante ni
  // la devolvio en blanco. Son selectores y no marcadores porque
  // `TemplatesService` prohibe los marcadores libres: una ranura a rellenar solo
  // se puede nombrar por su posicion en el DOM.
  @IsOptional()
  @IsArray({ message: 'requiredSelectors debe ser un arreglo.' })
  @ArrayMaxSize(MAX_REQUIRED_SELECTORS, {
    message: `requiredSelectors no puede declarar mas de ${MAX_REQUIRED_SELECTORS} selectores.`,
  })
  @IsString({ each: true, message: 'Cada selector debe ser una cadena.' })
  @IsNotEmpty({ each: true, message: 'Ningun selector puede estar vacio.' })
  @MaxLength(MAX_SELECTOR_LENGTH, {
    each: true,
    message: `Ningun selector puede superar ${MAX_SELECTOR_LENGTH} caracteres.`,
  })
  requiredSelectors?: string[];

  @ApiPropertyOptional({
    description:
      'Subconjunto de la lista blanca del saneador con el que ESTRECHAR lo publicable. Vacio u omitido = la lista blanca completa. Nunca la amplia: pedir una etiqueta que la lista global no admite es un error de configuracion, no una concesion.',
    type: [String],
    example: ['h1', 'p', 'div'],
  })
  @IsOptional()
  @IsArray({ message: 'allowedTags debe ser un arreglo.' })
  @ArrayMaxSize(MAX_ALLOWED_TAGS, {
    message: `allowedTags no puede declarar mas de ${MAX_ALLOWED_TAGS} etiquetas.`,
  })
  @IsString({ each: true, message: 'Cada etiqueta debe ser una cadena.' })
  @Matches(HTML_TAG_PATTERN, {
    each: true,
    message:
      'Cada etiqueta debe ser un nombre HTML en minusculas (ej. "h1", "div").',
  })
  allowedTags?: string[];
}

/** Configuracion del escudo con los valores por defecto ya aplicados. */
export interface ResolvedPostIaSanitizerConfig {
  readonly contentMode: PostIaContentMode;
  readonly sourceNamespace: string;
  /** Solo se lee en modo TEXT. */
  readonly sourceFields: readonly string[];
  readonly sourceField: string;
  readonly requiredSelectors: readonly string[];
  /** Vacio significa "toda la lista blanca del saneador", nunca "ninguna". */
  readonly allowedTags: readonly string[];
}

/**
 * Aplica los valores por defecto sobre un DTO ya validado. Funcion pura.
 *
 * Los defectos se resuelven aqui con `??` y NO con un inicializador de
 * propiedad en la clase: `plainToInstance` no corre con `exposeDefaultValues`,
 * asi que un inicializador no actuaria nunca (ver `imap-trigger-config.dto.ts`).
 */
export const resolvePostIaSanitizerConfig = (
  dto: PostIaSanitizerConfigDto,
): ResolvedPostIaSanitizerConfig => ({
  contentMode: dto.contentMode ?? DEFAULT_POST_IA_CONTENT_MODE,
  sourceNamespace: dto.sourceNamespace ?? DEFAULT_POST_IA_SOURCE_NAMESPACE,
  sourceFields:
    dto.sourceFields === undefined || dto.sourceFields.length === 0
      ? DEFAULT_POST_IA_SOURCE_FIELDS
      : dto.sourceFields,
  sourceField: dto.sourceField ?? DEFAULT_POST_IA_SOURCE_FIELD,
  requiredSelectors: dto.requiredSelectors ?? [],
  allowedTags: dto.allowedTags ?? [],
});
