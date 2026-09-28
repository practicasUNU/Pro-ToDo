import {
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

/**
 * Prompt del sistema con el que se pide la transcripcion.
 *
 * Es FIJO y no configurable, a diferencia del nodo de redaccion: aqui no hay
 * criterio editorial que ajustar —se pide el texto que hay en la imagen, ni mas
 * ni menos— y dejarlo abierto solo invitaria a pedirle al modelo que resumiera o
 * interpretara, que es justo lo que arruinaria el rescate. El nodo de IA que va
 * detras ya se encarga de la redaccion, y ese si elige su plantilla.
 */
export const PROMPT_OCR_MULTIMODAL =
  'Transcribe literalmente todo el texto visible en los documentos adjuntos. No resumas, no interpretes y no anadas comentarios: devuelve unicamente el texto tal como aparece, conservando el orden de lectura y los saltos de parrafo.';

/** Temperatura por defecto: la transcripcion no admite creatividad. */
export const DEFAULT_OCR_TEMPERATURE = 0.1;

export const MIN_OCR_TEMPERATURE = 0;
export const MAX_OCR_TEMPERATURE = 1;

export const DEFAULT_OCR_PROVIDER = LlmProvider.MOCK;
export const DEFAULT_OCR_MODEL = 'gemini-1.5-flash';
export const DEFAULT_OCR_TIMEOUT_MS = 30_000;
export const MIN_OCR_TIMEOUT_MS = 1_000;
export const MAX_OCR_TIMEOUT_MS = 120_000;
export const DEFAULT_OCR_MAX_RETRIES = 2;
export const MIN_OCR_RETRIES = 0;
export const MAX_OCR_RETRIES = 5;

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
  dryRun: dto.dryRun ?? false,
});
