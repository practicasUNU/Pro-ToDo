import type { LlmProvider } from '@/types/nodes/llm-extractor.types';

/**
 * Prompt del sistema con el que se pide la transcripcion.
 *
 * REPLICA LITERAL del backend (`ocr-processor-config.dto.ts`): cualquier cambio
 * alli debe copiarse aqui, o la interfaz enseñaria al operador un prompt que ya
 * no se usa.
 *
 * Se muestra en SOLO LECTURA. Aqui no hay criterio editorial que ajustar —se
 * pide el texto que hay en la imagen, ni mas ni menos— y dejarlo abierto
 * invitaria a pedirle al modelo que resumiera, que es justo lo que arruinaria
 * el rescate. El nodo de IA que va detras ya se encarga de la redaccion, y ese
 * si elige su plantilla.
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

export const DEFAULT_OCR_TEMPERATURE = 0.1;
export const MIN_OCR_TEMPERATURE = 0;
export const MAX_OCR_TEMPERATURE = 1;

// Espejo de `DEFAULT_OCR_MODEL` del backend, que a su vez sale de
// `DEFAULT_GEMINI_MODEL`. Se mueven A LA VEZ: Google retiro `gemini-1.5-flash`
// de `v1beta`, y un formulario que proponga un modelo muerto crea flujos que
// fallan con un 404 en la primera ejecucion.
export const DEFAULT_OCR_MODEL = 'gemini-3.6-flash';

export const DEFAULT_OCR_TIMEOUT_MS = 30_000;
export const MIN_OCR_TIMEOUT_MS = 1_000;
export const MAX_OCR_TIMEOUT_MS = 120_000;

/**
 * Reintentos rapidos de red. REPLICA de `DEFAULT_OCR_MAX_RETRIES` (backend).
 *
 * Bajo de dos a uno por el mismo motivo que el del nodo de redaccion: un
 * timeout se reintenta, asi que la espera se multiplica por los intentos y
 * luego otra vez por la cadena de respaldo de proveedores.
 */
export const DEFAULT_OCR_MAX_RETRIES = 1;
export const MIN_OCR_RETRIES = 0;
/**
 * TRES y no cinco. Replica del techo del DTO del backend, que bajo porque el
 * motor ejecuta los nodos EN LINEA: el tiempo que una ejecucion pasa bloqueada
 * es `timeoutMs x (maxRetries + 1)` y se repite por cada proveedor de la cadena
 * de respaldo. El suelo sigue en CERO —apagar los reintentos es la
 * configuracion mas barata frente a un proveedor de pago—.
 */
export const MAX_OCR_RETRIES = 3;

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
