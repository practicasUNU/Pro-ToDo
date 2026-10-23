import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { LlmProvider } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import { clamp } from '@common/utils/clamp.util';
import {
  applyEnvironmentCeiling,
  applyEnvironmentFloor,
} from '@common/utils/env-precedence.util';
import { DEFAULT_GEMINI_MODEL } from '@modules/nodes/strategies/providers/gemini-llm.provider';

import type { AiHttpDefaults } from '@core/config/ai-defaults.config';

/**
 * Prompt POR DEFECTO con el que se pide la transcripcion.
 *
 * Un flujo puede sustituirlo con `customPrompt` (por ejemplo, para pedir que
 * se ignoren los sellos o que se transcriba solo una seccion), pero este sigue
 * siendo el que se usa si el nodo no declara otro. La forma de la SALIDA no
 * depende de el: el contrato JSON lo anade el proveedor al system prompt, asi
 * que un prompt propio no puede romper el formato que lee la estrategia. Lo que
 * si puede es pedir que se resuma o interprete, que arruinaria el rescate; de
 * ahi que el editor del frontend parta siempre de este texto.
 *
 * PIDE MARKDOWN GFM, y no es un capricho de formato. La version anterior pedia
 * "el texto tal como aparece" sin mas, y con un documento de texto corrido
 * bastaba; con una tabla —el caso de `VERIFICADOR_TITULOS_DEFAULT`, que procesa
 * comisiones de acreditacion— la transcripcion llegaba como un amasijo de
 * celdas sin estructura y el nodo de IA no podia reconstruirla.
 *
 * LA DIRECTIVA 3 ES LA QUE SOSTIENE LAS TABLAS. El proveedor devuelve
 * `body_paragraphs: string[]` y `OcrProcessorStrategy.flattenTranscription` los
 * une; si el modelo emite una fila por elemento, la linea en blanco entre el
 * separador `|---|` y las filas rompe la tabla. Pedir un unico bloque lo evita
 * en origen, y la union consciente de tablas de la estrategia lo cubre por si
 * el modelo desobedece. Las dos defensas hacen falta: cuando el motor detecta
 * texto util libera los binarios del adjunto, asi que una tabla rota no se
 * puede volver a transcribir.
 */
export const PROMPT_OCR_MULTIMODAL = [
  'Eres un motor de transcripcion documental. Transcribe integramente el texto visible en los documentos adjuntos usando Markdown GFM.',
  '',
  '1. TEXTO CORRIDO: parrafos separados por una linea en blanco. Usa encabezados (# y ##) solo donde el documento original tenga titulos.',
  '2. TABLAS: sintaxis GFM, con fila de cabecera y separador (|---|). Si una celda esta combinada verticalmente y abarca varias filas, REPITE su valor en cada una de esas filas; no dejes huecos.',
  '3. UN SOLO BLOQUE: devuelve la transcripcion completa como un unico elemento, con sus saltos de linea dentro. No la repartas en fragmentos.',
  '4. PROHIBIDO: saludos, notas introductorias, comentarios sobre lo que has hecho y delimitadores de bloque de codigo (```), salvo que el documento original los contenga.',
  '5. No resumas, no interpretes y no completes lo que no se lea. Respeta el orden de lectura y la grafia de nombres propios tal y como figuran.',
].join('\n');

/** Temperatura por defecto: la transcripcion no admite creatividad. */
export const DEFAULT_OCR_TEMPERATURE = 0.1;

export const MIN_OCR_TEMPERATURE = 0;
export const MAX_OCR_TEMPERATURE = 1;

/**
 * Proveedor por defecto: Gemini.
 *
 * Fue `MOCK` hasta PROT-22, y el par era incoherente —el modelo por defecto ya
 * era `gemini-1.5-flash`—. Peor que incoherente: un nodo de OCR que simula en
 * silencio publica texto inventado como si fuera una transcripcion, y el fallo
 * no aparece hasta que alguien lee la noticia publicada. El free tier de Google
 * AI Studio cuesta $0, y sin `GEMINI_API_KEY` el cliente degrada igualmente al
 * simulador, asi que el cambio no puede abrir ninguna factura.
 */
export const DEFAULT_OCR_PROVIDER = LlmProvider.GEMINI;
export const DEFAULT_OCR_MODEL = DEFAULT_GEMINI_MODEL;
export const DEFAULT_OCR_TIMEOUT_MS = 30_000;
export const MIN_OCR_TIMEOUT_MS = 1_000;
export const MAX_OCR_TIMEOUT_MS = 120_000;
/**
 * Reintentos rapidos de red por defecto, adicionales al primer intento.
 *
 * UNO, y antes eran dos. Mismo argumento que `DEFAULT_LLM_MAX_RETRIES`: un
 * `ERR_HTTP_TIMEOUT` se reintenta, de modo que la espera se gasta
 * `timeoutMs × (maxRetries + 1)` veces y el ciclo entero se repite ademas por
 * cada proveedor de la cadena de respaldo. Con el techo de 120 000 ms de este
 * nodo, la cuenta se dispara deprisa.
 */
export const DEFAULT_OCR_MAX_RETRIES = 1;
export const MIN_OCR_RETRIES = 0;
/**
 * Techo de reintentos internos. Ver el AVISO sobre los dos niveles.
 *
 * TRES y no cinco: el motor ejecuta los nodos EN LINEA, asi que el tiempo que
 * una ejecucion pasa bloqueada es `timeoutMs x (maxRetries + 1)` y se repite
 * ademas por cada proveedor de la cadena de respaldo. Con el techo de espera de
 * este nodo, cinco reintentos retenian el mutex del flujo durante mas de diez
 * minutos por proveedor, y lo que resuelve un proveedor saturado no es insistir
 * contra el sino saltar al siguiente.
 *
 * El suelo sigue siendo CERO y no uno: apagar los reintentos es una
 * configuracion legitima —y la mas barata frente a un proveedor de pago—, asi
 * que exigir al menos uno quitaria la unica forma de expresarla.
 */
export const MAX_OCR_RETRIES = 3;

/**
 * Espera base entre reintentos de la transcripcion, en milisegundos.
 *
 * Gemela de `LLM_RETRY_BASE_DELAY_MS`, y por el mismo motivo: los 500 ms que
 * `HttpClientService` aplica por defecto estan pensados para un portal web, no
 * para un modelo que acaba de devolver un 429 de cuota. No es un campo del DTO
 * porque no es una decision del operador.
 */
export const OCR_RETRY_BASE_DELAY_MS = 2_500;

/** Tope de la respuesta. Una transcripcion larga cabe de sobra en 4096. */
// 8192 y no 4096 desde PROT-24. En la gama Gemini 3.x este tope cubre TAMBIEN
// los tokens de pensamiento, asi que no es el tamano de la respuesta sino el
// presupuesto total: con 4096, el modelo gastaba ~1000 deliberando y la
// transcripcion salia cortada a media cadena JSON (`finishReason: MAX_TOKENS`).
// Se acota ademas el pensamiento en la propia llamada; las dos cosas hacen
// falta, porque subir el tope sin acotarlo solo aplaza el corte.
export const DEFAULT_OCR_MAX_TOKENS = 8_192;
export const MIN_OCR_MAX_TOKENS = 256;
export const MAX_OCR_MAX_TOKENS = 32_768;

/**
 * Tipos de adjunto que un modelo multimodal sabe mirar.
 *
 * Es la lista por defecto; el nodo puede recortarla con `allowedMimeTypes`
 * —nunca ampliarla a algo que el proveedor no entienda, porque el filtro final
 * sigue siendo esta constante—.
 */
export const DEFAULT_OCR_ALLOWED_MIME_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
];

/** Techo del prompt propio del OCR, holgado para unas instrucciones de transcripcion. */
export const MAX_OCR_CUSTOM_PROMPT_LENGTH = 8_000;

/**
 * `params` del nodo `PROCESADOR_OCR`.
 *
 * Deliberadamente MAS CORTO que el del nodo de redaccion: no hay
 * `templatePromptId` porque el prompt no es una plantilla compartida, y sin eso
 * desaparecen tambien el freno de emergencia por prompts en bucle y la
 * resolucion de plantillas. El prompt se puede sustituir EN LINEA con
 * `customPrompt`; sin el, se usa `PROMPT_OCR_MULTIMODAL`.
 *
 * Se valida con `whitelist: true, forbidNonWhitelisted: true`, asi que una clave
 * de mas se rechaza en vez de guardarse en silencio.
 */
/**
 * Namespace donde este nodo deja su transcripcion por convencion.
 *
 * Coincide con el `outputNamespace` que el asistente asigna al nodo, y existe
 * como DEFAULT porque la estrategia no recibe el suyo: `INodeStrategy.execute`
 * toma `(context, node.params)`, de modo que un nodo no puede leer lo que el
 * mismo publico sin que alguien se lo diga. Ver `cacheNamespace`.
 */
export const DEFAULT_OCR_CACHE_NAMESPACE = 'ocr_result';

export class OcrProcessorConfigDto {
  @ApiPropertyOptional({ enum: LlmProvider, default: DEFAULT_OCR_PROVIDER })
  @IsOptional()
  @IsEnum(LlmProvider, {
    message: `provider debe ser uno de: ${Object.values(LlmProvider).join(', ')}.`,
  })
  provider?: LlmProvider;

  @ApiPropertyOptional({ default: DEFAULT_OCR_MODEL })
  @IsOptional()
  @IsString({ message: 'model debe ser una cadena.' })
  model?: string;

  @ApiPropertyOptional({
    description:
      'Grado de libertad del modelo. Por defecto 0.1: una transcripcion que se aparta de lo que pone en la imagen es un error, no una variante.',
    default: DEFAULT_OCR_TEMPERATURE,
  })
  @IsOptional()
  @IsNumber({}, { message: 'temperature debe ser un numero.' })
  @Min(MIN_OCR_TEMPERATURE, {
    message: `temperature no puede ser menor que ${MIN_OCR_TEMPERATURE}.`,
  })
  @Max(MAX_OCR_TEMPERATURE, {
    message: `temperature no puede ser mayor que ${MAX_OCR_TEMPERATURE}.`,
  })
  temperature?: number;

  @ApiPropertyOptional({ default: DEFAULT_OCR_TIMEOUT_MS })
  @IsOptional()
  @IsInt({ message: 'timeoutMs debe ser un entero.' })
  @Min(MIN_OCR_TIMEOUT_MS, {
    message: `timeoutMs no puede ser menor que ${MIN_OCR_TIMEOUT_MS}.`,
  })
  @Max(MAX_OCR_TIMEOUT_MS, {
    message: `timeoutMs no puede ser mayor que ${MAX_OCR_TIMEOUT_MS}.`,
  })
  timeoutMs?: number;

  @ApiPropertyOptional({ default: DEFAULT_OCR_MAX_RETRIES })
  @IsOptional()
  @IsInt({ message: 'maxRetries debe ser un entero.' })
  @Min(MIN_OCR_RETRIES, {
    message: `maxRetries no puede ser menor que ${MIN_OCR_RETRIES}.`,
  })
  @Max(MAX_OCR_RETRIES, {
    message: `maxRetries no puede ser mayor que ${MAX_OCR_RETRIES}.`,
  })
  maxRetries?: number;

  @ApiPropertyOptional({ default: DEFAULT_OCR_MAX_TOKENS })
  @IsOptional()
  @IsInt({ message: 'maxTokens debe ser un entero.' })
  @Min(MIN_OCR_MAX_TOKENS, {
    message: `maxTokens no puede ser menor que ${MIN_OCR_MAX_TOKENS}.`,
  })
  @Max(MAX_OCR_MAX_TOKENS, {
    message: `maxTokens no puede ser mayor que ${MAX_OCR_MAX_TOKENS}.`,
  })
  maxTokens?: number;

  @ApiPropertyOptional({
    description:
      'Tipos de adjunto que este nodo acepta. Solo sirve para RECORTAR la lista por defecto: un tipo que no este en ella se ignora igualmente, porque el proveedor no sabria que hacer con el.',
    isArray: true,
    type: String,
    default: DEFAULT_OCR_ALLOWED_MIME_TYPES,
  })
  @IsOptional()
  @IsArray({ message: 'allowedMimeTypes debe ser un arreglo.' })
  @ArrayNotEmpty({
    message:
      'allowedMimeTypes no puede ser un arreglo vacio: omitelo para aceptar todos los tipos soportados.',
  })
  @IsString({
    each: true,
    message: 'allowedMimeTypes solo admite cadenas.',
  })
  allowedMimeTypes?: string[];

  @ApiPropertyOptional({
    description:
      'Fuerza la simulacion de coste cero, igual que en el nodo de redaccion.',
    default: false,
  })
  @IsOptional()
  @IsBoolean({ message: 'dryRun debe ser un booleano.' })
  dryRun?: boolean;

  @ApiPropertyOptional({
    description:
      'Namespace del que se recupera una transcripcion previa al reanudar un flujo cuyos binarios ya se liberaron (RNF-01). Debe coincidir con el `outputNamespace` del propio nodo.',
    default: DEFAULT_OCR_CACHE_NAMESPACE,
  })
  @IsOptional()
  @IsString({ message: 'cacheNamespace debe ser una cadena.' })
  cacheNamespace?: string;

  @ApiPropertyOptional({
    description:
      'Instrucciones de transcripcion propias de este nodo. Sin ellas se usa el prompt por defecto (`PROMPT_OCR_MULTIMODAL`).',
    maxLength: MAX_OCR_CUSTOM_PROMPT_LENGTH,
  })
  @IsOptional()
  @IsString({ message: 'customPrompt debe ser una cadena.' })
  @IsNotEmpty({
    message:
      'customPrompt no puede estar vacio: omitelo para usar el prompt por defecto.',
  })
  @MaxLength(MAX_OCR_CUSTOM_PROMPT_LENGTH, {
    message: `customPrompt no puede superar ${MAX_OCR_CUSTOM_PROMPT_LENGTH} caracteres.`,
  })
  customPrompt?: string;
}

/** Configuracion del OCR con los valores por defecto ya aplicados. */
export interface ResolvedOcrProcessorConfig {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly temperature: number;
  readonly timeoutMs: number;
  readonly maxRetries: number;

  /** Espera base del backoff entre reintentos. Ver `OCR_RETRY_BASE_DELAY_MS`. */
  readonly baseDelayMs: number;
  readonly maxTokens: number;
  readonly allowedMimeTypes: readonly string[];
  readonly dryRun: boolean;
  readonly cacheNamespace: string;

  /** Prompt de transcripcion efectivo: el propio del nodo o el por defecto. */
  readonly prompt: string;
}

/**
 * Aplica los defaults del DTO sobre una instancia ya validada.
 *
 * `env` es el escalon intermedio de la politica de red, con la precedencia
 * `params del nodo > entorno > constante`. Lleva valor por defecto para seguir
 * siendo invocable con un solo argumento donde no hay entorno que consultar.
 */
export const resolveOcrProcessorConfig = (
  dto: OcrProcessorConfigDto,
  env: AiHttpDefaults = { timeoutMs: null, maxRetries: null },
): ResolvedOcrProcessorConfig => ({
  provider: dto.provider ?? DEFAULT_OCR_PROVIDER,
  model: dto.model ?? DEFAULT_OCR_MODEL,
  temperature: dto.temperature ?? DEFAULT_OCR_TEMPERATURE,
  // PISO para la espera y TECHO para los reintentos, igual que en el nodo de
  // redaccion y por los mismos motivos: su store tambien publica los dos
  // valores en el esquema al guardar, de modo que sin esto `OCR_HTTP_*` no
  // alcanzaria a ningun flujo ya configurado.
  //
  // El `clamp` sigue haciendo falta por el valor del ENTORNO: lo que viene en
  // `dto` ya paso por los `@Min`/`@Max` de arriba, pero una variable del `.env`
  // no atraviesa `class-validator` en ninguna parte.
  timeoutMs: clamp(
    applyEnvironmentFloor(dto.timeoutMs, env.timeoutMs, DEFAULT_OCR_TIMEOUT_MS),
    MIN_OCR_TIMEOUT_MS,
    MAX_OCR_TIMEOUT_MS,
  ),
  maxRetries: clamp(
    applyEnvironmentCeiling(
      dto.maxRetries,
      env.maxRetries,
      DEFAULT_OCR_MAX_RETRIES,
    ),
    MIN_OCR_RETRIES,
    MAX_OCR_RETRIES,
  ),
  baseDelayMs: OCR_RETRY_BASE_DELAY_MS,
  maxTokens: dto.maxTokens ?? DEFAULT_OCR_MAX_TOKENS,
  allowedMimeTypes: dto.allowedMimeTypes ?? DEFAULT_OCR_ALLOWED_MIME_TYPES,
  dryRun: dto.dryRun ?? false,
  cacheNamespace: dto.cacheNamespace ?? DEFAULT_OCR_CACHE_NAMESPACE,
  // Un prompt de solo espacios cuenta como ausente: `@IsNotEmpty` no lo para.
  prompt:
    dto.customPrompt !== undefined && dto.customPrompt.trim().length > 0
      ? dto.customPrompt.trim()
      : PROMPT_OCR_MULTIMODAL,
});
