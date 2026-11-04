import type { UserRole } from '@/types/user';

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

/** Modelo por defecto cuando el nodo no declara uno. Espejo del backend. */
export const DEFAULT_LLM_MODEL = 'gemini-3.6-flash';

/** Espera maxima por defecto de la inferencia, en milisegundos. */
export const DEFAULT_LLM_TIMEOUT_MS = 15_000;
export const MIN_LLM_TIMEOUT_MS = 1_000;

/**
 * Techo de la espera. REPLICA de `MAX_LLM_TIMEOUT_MS` (backend).
 *
 * Fueron 60 000 hasta que se vio que redactar una plantilla institucional a
 * partir de una tabla de trece comisiones universitarias se pasa de largo de
 * ese minuto. Con el tope ahi, el operador veia el campo en rojo y no tenia
 * forma de arreglarlo sin desplegar. Son los mismos 120 000 que ya admite el
 * nodo de OCR.
 */
export const MAX_LLM_TIMEOUT_MS = 120_000;

/**
 * Reintentos RAPIDOS DE RED, adicionales al primer intento.
 *
 * UNO, y antes eran tres. REPLICA de `DEFAULT_LLM_MAX_RETRIES` (backend): un
 * timeout SI se reintenta, de modo que la espera no se gasta una vez sino
 * `timeoutMs × (maxRetries + 1)`, y el ciclo se repite ademas por cada
 * proveedor de la cadena de respaldo.
 */
export const DEFAULT_LLM_MAX_RETRIES = 1;
export const MIN_LLM_RETRIES = 0;
/**
 * TRES y no cinco. Replica del techo del DTO del backend, que bajo porque el
 * motor ejecuta los nodos EN LINEA: el tiempo que una ejecucion pasa bloqueada
 * es `timeoutMs x (maxRetries + 1)` y se repite por cada proveedor de la cadena
 * de respaldo. El suelo sigue en CERO —apagar los reintentos es la
 * configuracion mas barata frente a un proveedor de pago—.
 */
export const MAX_LLM_RETRIES = 3;

/** Fallos consecutivos del proveedor que activan el freno de emergencia. */
export const DEFAULT_LLM_EMERGENCY_BRAKE_THRESHOLD = 3;
export const MIN_LLM_EMERGENCY_BRAKE_THRESHOLD = 1;
export const MAX_LLM_EMERGENCY_BRAKE_THRESHOLD = 5;

/**
 * Presupuesto de tokens cuando el nodo debe devolver la plantilla rellena.
 *
 * REPLICA de `DEFAULT_LLM_MARKUP_MAX_TOKENS` (backend). Solo se aplica en ese
 * caso: el backend lo resuelve en `resolveMaxTokens` y, SIN plantilla, no envia
 * tope ninguno —fijar una cifra ahi recortaria flujos que hoy redactan largo con
 * el defecto que aplica cada proveedor—.
 *
 * Por eso el campo del cliente es `number | null` y su defecto es `null`: aqui
 * `null` no significa "sin limite", significa "decide tu", que es una tercera
 * opcion que un numero no puede expresar.
 */
export const DEFAULT_LLM_MARKUP_MAX_TOKENS = 8_192;
export const MIN_LLM_MAX_TOKENS = 256;
export const MAX_LLM_MAX_TOKENS = 32_768;

/**
 * Presupuestos por defecto segun la cardinalidad. Replica de las constantes
 * homonimas de `llm-extractor-config.dto.ts`: sin `maxTokens` declarado, el
 * backend envia 8192 con un elemento y 16384 con un lote.
 */
export const DEFAULT_MAX_TOKENS_SINGLE = DEFAULT_LLM_MARKUP_MAX_TOKENS;
export const DEFAULT_MAX_TOKENS_MULTIPLE = 16_384;
export const MAX_HARD_CEILING_TOKENS = MAX_LLM_MAX_TOKENS;

/**
 * Umbral de `maxRetries` a partir del cual se avisa del efecto multiplicativo.
 *
 * Se ata al defecto del backend, que no merece aviso. Por encima, el TSDoc del
 * DTO advierte de que esta capa y el `retryPolicy` del esquema SE MULTIPLICAN,
 * y de que cada vuelta factura tokens. El umbral baja con el defecto —de tres a
 * uno— y eso hace el aviso mas sensible a proposito: con el techo de la espera
 * en 120 000 ms, la cuenta se dispara antes que con los 60 000 de antes.
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
/**
 * Cardinalidad de la salida del nodo de IA. Replica de `LlmOutputCardinality`
 * (@modules/nodes/dto/llm-extractor-config.dto.ts).
 *
 * `MULTIPLE` pide un lote: el primer elemento en la raiz del JSON y el resto en
 * `items`. El escudo valida cada uno y los destinos los publican en bucle.
 * `AUTO` usa el mismo esquema, pero el modelo detecta si hay uno o varios
 * elementos; el backend publica la cardinalidad efectiva en
 * `resolved_cardinality`.
 */
export type LlmOutputCardinality = 'SINGLE' | 'MULTIPLE' | 'AUTO';

/** Si la cardinalidad presupuesta y estima como un lote (todo salvo `SINGLE`). */
export const isBatchCardinality = (cardinality: LlmOutputCardinality): boolean =>
  cardinality !== 'SINGLE';

export const DEFAULT_LLM_OUTPUT_CARDINALITY: LlmOutputCardinality = 'SINGLE';

/** Opciones cerradas del selector (Poka-Yoke): nada de texto libre. */
export const LLM_OUTPUT_CARDINALITY_OPTIONS: ReadonlyArray<{
  readonly value: LlmOutputCardinality;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: 'SINGLE',
    label: 'Un elemento (1:1 Estricto)',
    description:
      'Una noticia, un expediente o un enlace por correo. Presupuesto: 8192 tokens como maximo.',
  },
  {
    value: 'MULTIPLE',
    label: 'Lote de elementos (1:N Estricto)',
    description:
      'El correo trae varios: la respuesta incluye "items" y los destinos publican cada uno. Presupuesto: 16384 tokens como maximo.',
  },
  {
    value: 'AUTO',
    label: 'Autodetección Tolerante (1:1 / 1:N)',
    description:
      'El modelo decide si hay uno o varios elementos y la cardinalidad se ajusta a su respuesta. Presupuesta como un lote.',
  },
];

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
  /**
   * Tope de tokens de la respuesta, o `null` para dejar decidir al nodo.
   *
   * `null` y no un numero por defecto: el backend distingue tres escalones —lo
   * que declare el nodo, el tope de marcado cuando toca devolver una plantilla,
   * y el defecto del proveedor— y un numero aqui colapsaria los dos ultimos.
   */
  maxTokens: number | null;
  /** Un elemento o un lote. Ver `LlmOutputCardinality`. */
  outputCardinality: LlmOutputCardinality;
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
  /**
   * Rol minimo para poder usar el modelo. Ausente = sin restriccion.
   *
   * Lo llevan los modelos FACTURABLES: elegir uno compromete presupuesto en
   * cada ejecucion del flujo. El catalogo se sirve entero a los dos roles y
   * este campo solo lo marca, para que la interfaz pueda deshabilitar la
   * opcion; la prohibicion de verdad la aplica el backend al guardar.
   */
  readonly minRoleRequired?: UserRole;
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
  /** Solo si la prueba se hizo pero su consumo no quedo registrado. */
  readonly telemetryWarning?: string;
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

/**
 * Opcion del selector de modelo, ya resuelta para pintar su distintivo.
 *
 * Vive en `types/` y no en el store del nodo de IA —donde nacio— porque desde
 * PROT-22 la comparten los dos nodos que consumen un LLM.
 */
export interface LlmModelOption {
  readonly label: string;
  readonly value: string;
  readonly provider: LlmProvider;
  readonly availability: LlmModelAvailability;
  readonly contextWindow: number;
  /** true si no figura en el catalogo del backend. Ver `buildModelOptions`. */
  readonly isUncatalogued: boolean;
  /**
   * El rol actual no alcanza para este modelo.
   *
   * Se llama `disable` y no `isForbidden` porque es el nombre que espera
   * `option-disable` de `QSelect`: renombrarlo obligaria a un `map` extra en
   * cada componente para traducirlo de vuelta.
   */
  readonly disable: boolean;
}

/**
 * Insignia de los modelos reservados al ADMIN.
 *
 * Token de la paleta, nunca un color de Quasar ni un hexadecimal
 * (`frontend-quasar.md` §2).
 */
export const ADMIN_ONLY_LABEL = 'Solo Admin';
export const ADMIN_ONLY_TOKEN = 'var(--pd-warning)';

/** Clasifica un modelo del catalogo. El simulador manda sobre la credencial. */
export const resolveModelAvailability = (
  descriptor: Pick<LlmModelDescriptor, 'isAvailable' | 'isTestOnly'>,
): LlmModelAvailability => {
  if (descriptor.isTestOnly) {
    return 'TEST_ONLY';
  }

  return descriptor.isAvailable ? 'AVAILABLE' : 'MISSING_KEY';
};
