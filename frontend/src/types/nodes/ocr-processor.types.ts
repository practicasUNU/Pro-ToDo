import type { LlmProvider } from '@/types/nodes/llm-extractor.types';

/**
 * Prompt del sistema con el que se pide la transcripcion.
 *
 * REPLICA del backend (`ocr-processor-config.dto.ts`) y se muestra en SOLO
 * LECTURA: aqui no hay criterio editorial que ajustar —se pide el texto que hay
 * en la imagen, ni mas ni menos— y dejarlo abierto invitaria a pedirle al modelo
 * que resumiera, que es justo lo que arruinaria el rescate. El nodo de IA que va
 * detras ya se encarga de la redaccion, y ese si elige su plantilla.
 */
export const PROMPT_OCR_MULTIMODAL =
  'Transcribe literalmente todo el texto visible en los documentos adjuntos. No resumas, no interpretes y no anadas comentarios: devuelve unicamente el texto tal como aparece, conservando el orden de lectura y los saltos de parrafo.';

export const DEFAULT_OCR_TEMPERATURE = 0.1;
export const MIN_OCR_TEMPERATURE = 0;
export const MAX_OCR_TEMPERATURE = 1;

export const DEFAULT_OCR_MODEL = 'gemini-1.5-flash';

export const DEFAULT_OCR_TIMEOUT_MS = 30_000;
export const MIN_OCR_TIMEOUT_MS = 1_000;
export const MAX_OCR_TIMEOUT_MS = 120_000;

export const DEFAULT_OCR_MAX_RETRIES = 2;
export const MIN_OCR_RETRIES = 0;
export const MAX_OCR_RETRIES = 5;

/**
 * Configuracion del nodo `PROCESADOR_OCR`.
 *
 * Deliberadamente MAS CORTA que la del nodo de redaccion: sin plantilla de
 * prompt ni instruccion en linea, porque el prompt es del sistema. Lo que queda
 * es el presupuesto de la llamada.
 */
export interface OcrProcessorNodeConfig {
  provider: LlmProvider;
  model: string;
  temperature: number;
  timeoutMs: number;
  maxRetries: number;
  dryRun: boolean;
}
