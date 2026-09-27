// Replica de `LlmExtractorConfigDto` (@modules/nodes/dto/llm-extractor-config.dto.ts).
// Cualquier cambio alli debe reflejarse aqui.

/**
 * Proveedores que el nodo puede declarar.
 *
 * Replica de `LlmProvider` (@modules/nodes/strategies/interfaces). Se declara
 * como enum real y no como union de cadenas porque se recorre en tiempo de
 * ejecucion para poblar el selector.
 *
 * OJO con los dos ultimos: desde PROT-16, `ANTHROPIC` y `OPENAI` NO fallan —
 * degradan al simulador con un aviso en el log, y su salida se marca con
 * `metadata.isMock`. Elegirlos no da error, da una redaccion simulada, que es
 * peor si nadie lo sabe. El formulario tiene que decirlo.
 */
export enum LlmProvider {
  MOCK = 'MOCK',
  GEMINI = 'GEMINI',
  ANTHROPIC = 'ANTHROPIC',
  OPENAI = 'OPENAI',
}

/** Proveedores con cliente real implementado hoy. */
export const IMPLEMENTED_LLM_PROVIDERS: ReadonlySet<LlmProvider> = new Set([
  LlmProvider.MOCK,
  LlmProvider.GEMINI,
]);

/** Etiquetas del selector; el enum viaja crudo al backend. */
export const LLM_PROVIDER_LABELS: Record<LlmProvider, string> = {
  [LlmProvider.MOCK]: 'Simulador (coste cero)',
  [LlmProvider.GEMINI]: 'Google Gemini',
  [LlmProvider.ANTHROPIC]: 'Anthropic Claude',
  [LlmProvider.OPENAI]: 'OpenAI',
};

/** Defecto del backend: simulacion de coste cero. */
export const DEFAULT_LLM_PROVIDER = LlmProvider.MOCK;

/** Modelo por defecto cuando el nodo no declara uno. */
export const DEFAULT_LLM_MODEL = 'gemini-1.5-flash';

/** Espera maxima por defecto de la inferencia, en milisegundos. */
export const DEFAULT_LLM_TIMEOUT_MS = 15_000;
export const MIN_LLM_TIMEOUT_MS = 1_000;
export const MAX_LLM_TIMEOUT_MS = 60_000;

/** Reintentos RAPIDOS DE RED, adicionales al primer intento. */
export const DEFAULT_LLM_MAX_RETRIES = 3;
export const MIN_LLM_RETRIES = 0;
export const MAX_LLM_RETRIES = 5;

/** Fallos consecutivos del proveedor que activan el freno de emergencia. */
export const DEFAULT_LLM_EMERGENCY_BRAKE_THRESHOLD = 3;
export const MIN_LLM_EMERGENCY_BRAKE_THRESHOLD = 1;
export const MAX_LLM_EMERGENCY_BRAKE_THRESHOLD = 5;

/**
 * Umbral de `maxRetries` a partir del cual se avisa del efecto multiplicativo.
 *
 * Tres es el defecto del backend y no merece aviso. Por encima, el TSDoc del DTO
 * advierte de que esta capa y el `retryPolicy` del esquema SE MULTIPLICAN, y de
 * que cada vuelta factura tokens.
 */
export const LLM_RETRIES_WARNING_THRESHOLD = DEFAULT_LLM_MAX_RETRIES;

/**
 * Configuracion del nodo `PROCESADOR_IA` en el cliente.
 *
 * NINGUN campo es opcional aqui, aunque el DTO los admita todos ausentes: un
 * `undefined` enlazado a un `q-input` lo convierte en campo descontrolado en
 * Vue. La ausencia se representa con `''` o `null`, y es `toNodeParams()` quien
 * decide que se publica en el `pipeline_schema`.
 */
export interface LlmExtractorNodeConfig {
  /** UUID de la plantilla de prompt, o `null` si se escribe en linea. */
  templatePromptId: string | null;
  inlinePrompt: string;
  provider: LlmProvider;
  model: string;
  dryRun: boolean;
  timeoutMs: number;
  maxRetries: number;
  emergencyBrakeThreshold: number;
}
