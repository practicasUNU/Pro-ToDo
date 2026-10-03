import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { LlmProvider } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import { DEFAULT_GEMINI_MODEL } from '@modules/nodes/strategies/providers/gemini-llm.provider';

/**
 * Prompt del sistema con el que se pide la transcripcion.
 *
 * Es FIJO y no configurable, a diferencia del nodo de redaccion: aqui no hay
 * criterio editorial que ajustar —se pide el texto que hay en la imagen, ni mas
 * ni menos— y dejarlo abierto solo invitaria a pedirle al modelo que resumiera o
 * interpretara, que es justo lo que arruinaria el rescate. El nodo de IA que va
 * detras ya se encarga de la redaccion, y ese si elige su plantilla.
 *
 * PIDE MARKDOWN GFM, y no es un capricho de formato. La version anterior pedia
 * "el texto tal como aparece" sin mas, y con un documento de texto corrido
 * bastaba; con una tabla —el caso de `PANELES_UEM_DEFAULT`, que procesa
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
export const DEFAULT_OCR_MAX_RETRIES = 2;
export const MIN_OCR_RETRIES = 0;
export const MAX_OCR_RETRIES = 5;

/** Tope de la respuesta. Una transcripcion larga cabe de sobra en 4096. */
export const DEFAULT_OCR_MAX_TOKENS = 4_096;
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

/**
 * `params` del nodo `PROCESADOR_OCR`.
 *
 * Deliberadamente MAS CORTO que el del nodo de redaccion: no hay
 * `templatePromptId` ni `inlinePrompt` porque el prompt es del sistema, y sin
 * eso desaparecen tambien el freno de emergencia por prompts en bucle y la
 * resolucion de plantillas. Lo que queda es el presupuesto de la llamada.
 *
 * Se valida con `whitelist: true, forbidNonWhitelisted: true`, asi que una clave
 * de mas se rechaza en vez de guardarse en silencio.
 */
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
}

/** Configuracion del OCR con los valores por defecto ya aplicados. */
export interface ResolvedOcrProcessorConfig {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly temperature: number;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly maxTokens: number;
  readonly allowedMimeTypes: readonly string[];
  readonly dryRun: boolean;
}

/** Aplica los defaults del DTO sobre una instancia ya validada. */
export const resolveOcrProcessorConfig = (
  dto: OcrProcessorConfigDto,
): ResolvedOcrProcessorConfig => ({
  provider: dto.provider ?? DEFAULT_OCR_PROVIDER,
  model: dto.model ?? DEFAULT_OCR_MODEL,
  temperature: dto.temperature ?? DEFAULT_OCR_TEMPERATURE,
  timeoutMs: dto.timeoutMs ?? DEFAULT_OCR_TIMEOUT_MS,
  maxRetries: dto.maxRetries ?? DEFAULT_OCR_MAX_RETRIES,
  maxTokens: dto.maxTokens ?? DEFAULT_OCR_MAX_TOKENS,
  allowedMimeTypes: dto.allowedMimeTypes ?? DEFAULT_OCR_ALLOWED_MIME_TYPES,
  dryRun: dto.dryRun ?? false,
});
