import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Techo de selectores estructurales por nodo.
 *
 * Diez cubre cualquier maqueta institucional real. El limite no es una defensa
 * contra el abuso sino contra el uso equivocado: una lista de treinta selectores
 * suele significar que alguien esta describiendo la plantilla entera en vez de
 * las ranuras que la IA tiene que respetar.
 */
export const MAX_REQUIRED_SELECTORS = 10;

/** Longitud maxima de un selector CSS. */
export const MAX_SELECTOR_LENGTH = 120;

/**
 * Techo de la lista blanca por nodo.
 *
 * Coincide en orden de magnitud con `TEMPLATE_SANITIZER_CONFIG.allowedTags`, que
 * es el universo del que este parametro solo puede tomar un subconjunto.
 */
export const MAX_ALLOWED_TAGS = 40;

/** Nombre de etiqueta HTML en minusculas, tal y como lo escribe el saneador. */
const HTML_TAG_PATTERN = /^[a-z][a-z0-9]*$/;

/**
 * Configuracion del nodo `MAPEADOR_PLANTILLA`.
 *
 * SOBRE EL CAMBIO DE SEMANTICA. Este nodo ya NO compila la plantilla contra el
 * contexto acumulado: entrega el esqueleto HTML ya saneado para que un
 * `PROCESADOR_IA` posterior lo rellene. Por eso no hay aqui ningun parametro de
 * mapeo de variables, y por eso la plantilla elegida no debe traer marcadores
 * `{{nodo.campo}}`: nadie los sustituiria y saldrian literales en el HTML
 * publicado. La estrategia lo impide con `ERR_TEMPLATE_PENDING_VARS`.
 *
 * Todos los campos son OPCIONALES, por la misma razon que en
 * `WebScraperConfigDto`: una plantilla de flujo es un blueprint sin operativa y
 * se guarda con `params: {}`. `PipelineValidatorService` aplica este esquema a
 * plantillas y flujos por igual, asi que exigir `templateId` aqui impediria que
 * ninguna plantilla de flujo contuviera un mapeador. La pregunta "esta completo
 * para ejecutarse" vive en `getIncompleteParams`, que es lo que consulta
 * `assertActivatable` antes de habilitar un flujo.
 */
export class TemplateMapperConfigDto {
  @ApiPropertyOptional({
    description:
      'Identificador de la plantilla HTML del gestor (`plantillas_html`). Opcional al GUARDAR y obligatorio al ACTIVAR, que es donde lo exige `getIncompleteParams`.',
    format: 'uuid',
  })
  @IsOptional()
  @IsString({ message: 'templateId debe ser una cadena.' })
  @IsNotEmpty({ message: 'templateId no puede estar vacio.' })
  // La columna `id_plantilla` es UUID y el repositorio consulta por ella: sin
  // esta guarda, un identificador mal escrito llegaba hasta PostgreSQL para
  // volver como un `NotFoundException` generico.
  @IsUUID('4', { message: 'templateId debe ser un UUID valido.' })
  templateId?: string;

  @ApiPropertyOptional({
    description:
      'SOLO PRUEBAS: markup embebido que sustituye a la consulta del gestor. No pasa por la lista blanca que `TemplatesService` aplica al guardar una plantilla, asi que no debe usarse en un flujo de produccion.',
  })
  // Se declara aunque sea un escape de pruebas porque el validador corre con
  // `forbidNonWhitelisted: true`: omitirlo convertiria en 400 cualquier esquema
  // que lo use, incluida la semilla de verificacion del motor.
  @IsOptional()
  @IsString({ message: 'rawTemplate debe ser una cadena.' })
  rawTemplate?: string;

  @ApiPropertyOptional({
    description: `Selectores CSS que la plantilla DEBE contener una vez saneada (ej. "h1.titular"). Hasta ${MAX_REQUIRED_SELECTORS}.`,
    type: [String],
    example: ['h1.titular', 'div.cuerpo'],
  })
  // POR QUE ESTO EXISTE. `TemplatesService` rechaza al guardar cualquier
  // marcador que no sea un `{{namespace.campo}}` de la lista blanca
  // (`RESIDUAL_MARKER_PATTERN`), de modo que un "hueco a rellenar por la IA" NO
  // es expresable como marcador. La unica forma de nombrar una ranura es por su
  // posicion en el DOM, y de ahi que el contrato estructural sean selectores.
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
      'Subconjunto de la lista blanca del saneador con el que ESTRECHAR lo publicable. Vacio u omitido = la lista blanca completa. Nunca la amplia: pedir una etiqueta que la lista global no admite es un error de configuracion.',
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

/** Configuracion del mapeador con los valores por defecto ya aplicados. */
export interface ResolvedTemplateMapperConfig {
  readonly templateId: string;
  readonly rawTemplate: string | null;
  readonly requiredSelectors: readonly string[];
  /** Vacio significa "toda la lista blanca del saneador", nunca "ninguna". */
  readonly allowedTags: readonly string[];
}

/** Aplica los valores por defecto sobre un DTO ya validado. Funcion pura. */
export const resolveTemplateMapperConfig = (
  dto: TemplateMapperConfigDto,
): ResolvedTemplateMapperConfig => ({
  // `?? ''` y no un lanzamiento: el DTO admite la ausencia al guardar, asi que
  // aqui hay que representarla. Quien la convierte en un fallo diagnosticado es
  // la guarda de `resolveTemplate`, que emite ERR_TEMPLATE_NOT_RESOLVED.
  templateId: dto.templateId ?? '',
  rawTemplate: dto.rawTemplate ?? null,
  requiredSelectors: dto.requiredSelectors ?? [],
  allowedTags: dto.allowedTags ?? [],
});
