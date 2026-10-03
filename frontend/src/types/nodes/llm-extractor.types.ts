// Replica de `LlmExtractorConfigDto` (@modules/nodes/dto/llm-extractor-config.dto.ts).
// Cualquier cambio alli debe reflejarse aqui.

/**
 * Proveedores que el nodo puede declarar.
 *
 * Replica de `LlmProvider` (@modules/nodes/strategies/interfaces). Se declara
 * como enum real y no como union de cadenas porque se recorre en tiempo de
 * ejecucion para poblar el selector.
 *
 * OJO con `OPENAI`, el unico que queda sin cliente: NO falla — degrada al
 * simulador con un aviso en el log, y su salida se marca con
 * `metadata.isMock`. Elegirlo no da error, da una redaccion simulada, que es
 * peor si nadie lo sabe. El formulario tiene que decirlo.
 *
 * Y tener cliente tampoco garantiza una inferencia real: un proveedor sin su
 * clave de API degrada igual. Esa segunda mitad no se puede saber desde aqui,
 * y es justo lo que responde el catalogo (`GET /api/llm/models`).
 */
export enum LlmProvider {
  MOCK = 'MOCK',
  GEMINI = 'GEMINI',
  ANTHROPIC = 'ANTHROPIC',
  OPENAI = 'OPENAI',
}

/**
 * Proveedores con cliente real implementado hoy.
 *
 * Replica de lo que indexa `LlmProviderFactory` en el backend. Es la mitad
 * ESTATICA de la disponibilidad —la que solo cambia al desplegar—; la mitad
 * dinamica, si la credencial esta puesta, llega en `isAvailable` del catalogo.
 */
export const IMPLEMENTED_LLM_PROVIDERS: ReadonlySet<LlmProvider> = new Set([
  LlmProvider.MOCK,
  LlmProvider.GEMINI,
  LlmProvider.ANTHROPIC,
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
  /**
   * Codigo inmutable de la plantilla, alternativa portable al UUID.
   *
   * Cede ante `templatePromptId` si vienen los dos. Cadena vacia cuando no se
   * usa, no `undefined`, por la razon del bloque de arriba.
   */
  promptCode: string;
  inlinePrompt: string;
  provider: LlmProvider;
  model: string;
  dryRun: boolean;
  timeoutMs: number;
  maxRetries: number;
  emergencyBrakeThreshold: number;
}

/**
 * Un modelo del catalogo servido por `GET /api/llm/models`.
 *
 * Replica de `LlmModelDescriptor`
 * (@modules/nodes/dto/llm-catalog.dto.ts). Cualquier cambio alli debe
 * reflejarse aqui.
 *
 * `isAvailable` lo calcula el backend en cada peticion contra su propio
 * entorno. El navegador NO puede deducirlo: las credenciales viven solo en el
 * servidor (`security-and-scope.md` §0.1), y ese es el motivo de que este
 * catalogo sea un endpoint y no una constante del cliente.
 */
export interface LlmModelDescriptor {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly label: string;
  readonly isAvailable: boolean;
  readonly isTestOnly: boolean;
  readonly supportsVision: boolean;
  readonly contextWindow: number;
}

/** Cuerpo de `POST /api/llm/test-connection`. */
export interface LlmTestConnectionPayload {
  readonly provider: LlmProvider;
  readonly model: string;
}

/**
 * Resultado de la prueba de conectividad.
 *
 * Un fallo del proveedor llega como 200 con `success: false`, igual que en las
 * comprobaciones del asistente: solo un cuerpo mal formado produce un 4xx, y
 * ese si se propaga como excepcion.
 *
 * `isMock` es el campo que de verdad hay que mirar. Un `success: true` con
 * `isMock: true` significa que respondio el simulador porque falta la
 * credencial del proveedor elegido: la conexion "funciona" pero no es la que
 * el operador cree estar probando.
 */
export interface LlmTestConnectionResult {
  readonly success: boolean;
  readonly latencyMs: number;
  readonly isMock: boolean;
  readonly outputPreview: string;
  readonly error?: { readonly level: string; readonly message: string };
}

/** Estado de un modelo en el selector, para elegir el color del distintivo. */
export type LlmModelAvailability = 'AVAILABLE' | 'TEST_ONLY' | 'MISSING_KEY';

/** Texto del distintivo de cada estado. */
export const LLM_AVAILABILITY_LABELS: Record<LlmModelAvailability, string> = {
  AVAILABLE: 'Configurado',
  TEST_ONLY: 'Mock/Test',
  MISSING_KEY: 'Falta API Key',
};

/**
 * Color del distintivo, en tokens de la paleta (`frontend-quasar.md` §2).
 *
 * Se nombran los tokens y no colores de Quasar: la regla prohibe usar las
 * clases `bg-grey-N` y hardcodear hexadecimales en los componentes.
 */
export const LLM_AVAILABILITY_TOKENS: Record<LlmModelAvailability, string> = {
  AVAILABLE: 'var(--pd-positive)',
  TEST_ONLY: 'var(--pd-warning)',
  MISSING_KEY: 'var(--pd-negative)',
};

/** Clasifica un modelo del catalogo. El simulador manda sobre la credencial. */
export const resolveModelAvailability = (
  descriptor: Pick<LlmModelDescriptor, 'isAvailable' | 'isTestOnly'>,
): LlmModelAvailability => {
  if (descriptor.isTestOnly) {
    return 'TEST_ONLY';
  }

  return descriptor.isAvailable ? 'AVAILABLE' : 'MISSING_KEY';
};
