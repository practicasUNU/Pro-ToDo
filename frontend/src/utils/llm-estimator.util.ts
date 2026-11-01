import {
  DEFAULT_LLM_MARKUP_MAX_TOKENS,
  DEFAULT_LLM_MAX_RETRIES,
  DEFAULT_LLM_TIMEOUT_MS,
  MAX_LLM_MAX_TOKENS,
  MAX_LLM_TIMEOUT_MS,
} from '@/types/nodes/llm-extractor.types';

// Helper puro de presentacion (frontend-architecture.md §2.1): sin estado, sin
// E/S y sin dependencia de Pinia. Responde a UNA pregunta —cuanto va a costar
// esta inferencia— para que el operador la vea ANTES de ejecutar el flujo y no
// despues, en forma de ERR_HTTP_TIMEOUT o de JSON cortado a media cadena.

/** Cuanto trabajo se le viene encima al modelo. */
export type LlmComplexityLevel = 'BAJA' | 'MEDIA' | 'ALTA';

/** Proyeccion de recursos de una inferencia, con su recomendacion. */
export interface LlmResourceEstimate {
  /** Tokens que ocupa el marcado que se interpola en la instruccion. */
  readonly estimatedPromptTokens: number;

  /** Tokens que se espera que el modelo escriba de vuelta. */
  readonly estimatedOutputTokens: number;

  readonly recommendedTimeoutMs: number;

  /**
   * Tope sugerido, o `null` para DEJAR DECIDIR al backend.
   *
   * `null` no es "sin dato": es la recomendacion activa de no fijar nada, y es
   * lo correcto en la mayoria de los casos. El backend resuelve el presupuesto
   * en tres escalones y ya sube solo a 8192 cuando el prompt cita una plantilla
   * base; publicar un numero en los `params` DESACTIVA esa subida automatica y
   * congela el valor en el esquema para siempre. Solo se sugiere una cifra
   * cuando la proyeccion se sale de lo que el backend pondria por su cuenta.
   */
  readonly recommendedMaxTokens: number | null;

  /**
   * Reintentos sugeridos ante un fallo de red. Cada reintento FACTURA de nuevo
   * la inferencia entera, asi que en una coleccion larga se recomienda cero: es
   * preferible una espera mayor que pagar dos veces la misma tabla.
   */
  readonly recommendedMaxRetries: number;

  readonly complexityLevel: LlmComplexityLevel;

  /**
   * De donde sale la proyeccion: del marcado de la plantilla base o, sin ella,
   * de una estimacion a partir del prompt y del contexto que interpola.
   */
  readonly source: 'TEMPLATE' | 'PROMPT';

  /** Frase para el operador: por que sale este nivel y no otro. */
  readonly reason: string;
}

/**
 * Caracteres por token.
 *
 * Es una HEURISTICA, no una medida: contar de verdad exigiria el tokenizador
 * del modelo, que cambia con cada proveedor y no vive en el navegador. 3.8 y no
 * los 4 de la regla corriente porque aqui se cuenta marcado HTML —etiquetas,
 * atributos, comillas— y texto en espanol con acentos, y las dos cosas
 * tokenizan mas denso que la prosa inglesa sobre la que se calibro aquel 4.
 *
 * Al ser una estimacion por lo bajo, equivocarse aqui produce una recomendacion
 * conservadora, que es el lado seguro del error.
 */
const CHARS_PER_TOKEN = 3.8;

/**
 * Filas de una coleccion. Se cuentan `<tr` y `<li`, que son las dos formas en
 * que una plantilla institucional repite una ficha.
 */
const COLLECTION_ROW_PATTERN = /<(?:tr|li)\b/gi;

/**
 * Nombres que delatan una coleccion aunque el marcado no la repita todavia.
 *
 * La plantilla guardada suele traer UNA fila de muestra que el modelo tiene que
 * multiplicar, de modo que contar filas se queda corto justo en el caso que mas
 * importa. Estos terminos son los que usan las plantillas reales del portal.
 */
const COLLECTION_HINT_PATTERN = /\b(?:tableform|comites|comisiones|paneles|acreditacion)\b/i;

/** Filas a partir de las cuales el marcado ya es una coleccion de verdad. */
const COLLECTION_ROW_THRESHOLD = 3;

/**
 * Cuanto crece la salida respecto a la entrada.
 *
 * El modelo no resume la plantilla: la devuelve ENTERA y ademas rellena. El
 * tamano del marcado es por tanto el SUELO de la respuesta, no un dato
 * independiente, y este factor cubre la prosa que se escribe dentro.
 */
const OUTPUT_GROWTH_FACTOR = 1.6;

/** Suelo de la salida cuando hay coleccion: una tabla larga nunca sale barata. */
const COLLECTION_OUTPUT_FLOOR_TOKENS = 3_500;

/**
 * Margen sobre la proyeccion antes de recomendar un tope.
 *
 * Existe porque en la gama Gemini 3.x el tope cubre TAMBIEN los tokens de
 * pensamiento: el modelo puede gastar un millar deliberando antes de escribir
 * un solo caracter. Recomendar justo lo proyectado dejaria el corte a un
 * suspiro.
 */
const OUTPUT_SAFETY_MARGIN = 1.5;

/** Los topes se redondean a bloques de 1024, que es como se hablan. */
const TOKEN_STEP = 1_024;

/** Espera sugerida para un marcado sin colecciones. */
const MEDIUM_TIMEOUT_MS = 35_000;

/** Espera sugerida para una coleccion. Es el valor que el `.env` ya recomienda. */
const HIGH_TIMEOUT_MS = 60_000;

/**
 * Tokens que aporta cada campo del contexto interpolado, sin plantilla base.
 *
 * Heuristica gruesa: un campo tipico de un paso anterior (asunto, cuerpo de un
 * correo, texto extraido de una web) ronda unos cientos de tokens. No se conoce
 * su valor real hasta ejecutar, asi que se estima por lo alto.
 */
const TOKENS_PER_UPSTREAM_FIELD = 250;

/** Salida tipica de una redaccion sin plantilla (titular, resumen, parrafos). */
const PROMPT_ONLY_OUTPUT_TOKENS = 900;

/** Campos de contexto a partir de los cuales la redaccion deja de ser corta. */
const PROMPT_ONLY_MEDIUM_FIELDS = 6;

/** Tokens de un texto, por la heuristica de arriba. */
const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

/** Filas de coleccion presentes en el marcado. */
const countCollectionRows = (markup: string): number =>
  markup.match(COLLECTION_ROW_PATTERN)?.length ?? 0;

/** Redondea al alza al siguiente bloque de tokens. */
const roundUpToStep = (tokens: number): number => Math.ceil(tokens / TOKEN_STEP) * TOKEN_STEP;

/** Acota un numero al intervalo cerrado dado. */
const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, minimum), maximum);

/**
 * Estimacion sin plantilla base: a partir del prompt y del contexto que
 * interpola. Sin marcado que medir, la unica senal es cuanto material llega de
 * los pasos anteriores.
 */
const buildPromptOnlyEstimate = (upstreamFieldCount: number): LlmResourceEstimate => {
  const fields = Math.max(upstreamFieldCount, 0);
  const isMedium = fields >= PROMPT_ONLY_MEDIUM_FIELDS;

  return {
    estimatedPromptTokens: fields * TOKENS_PER_UPSTREAM_FIELD,
    estimatedOutputTokens: PROMPT_ONLY_OUTPUT_TOKENS,
    recommendedTimeoutMs: isMedium ? MEDIUM_TIMEOUT_MS : DEFAULT_LLM_TIMEOUT_MS,
    recommendedMaxTokens: null,
    recommendedMaxRetries: DEFAULT_LLM_MAX_RETRIES,
    complexityLevel: isMedium ? 'MEDIA' : 'BAJA',
    source: 'PROMPT',
    reason: isMedium
      ? `Sin plantilla base: estimado a partir del prompt y de ${fields} campos de contexto. La redaccion es mas larga de lo habitual; conviene algo mas de espera.`
      : 'Sin plantilla base: estimado a partir del prompt. La inferencia devuelve una redaccion corta y los valores por defecto le sobran.',
  };
};

/**
 * Proyecta lo que va a costar la inferencia a partir del MARCADO que la
 * alimenta.
 *
 * Se mide el marcado y no el texto de la instruccion a proposito: lo que hace
 * cara una inferencia de este flujo no es lo larga que sea la orden, sino
 * cuantas fichas tiene que rellenar. Las trece comisiones universitarias que
 * tumbaron el flujo de verificacion de titulos estaban en la tabla, no en el
 * prompt.
 *
 * Es una SUGERENCIA, nunca una imposicion: quien aplica la recomendacion es el
 * operador con un boton, y los campos manuales siguen mandando (Poka-Yoke de
 * `frontend-quasar.md` §4 — prevenir el error, no decidir por el usuario).
 */
export const estimateLlmResources = (
  baseMarkup: string | null,
  upstreamFieldCount = 0,
): LlmResourceEstimate => {
  const markup = baseMarkup?.trim() ?? '';

  if (markup.length === 0) {
    return buildPromptOnlyEstimate(upstreamFieldCount);
  }

  const estimatedPromptTokens = estimateTokens(markup);
  const rows = countCollectionRows(markup);
  const hasCollection = rows >= COLLECTION_ROW_THRESHOLD || COLLECTION_HINT_PATTERN.test(markup);

  const projectedOutput = Math.ceil(estimatedPromptTokens * OUTPUT_GROWTH_FACTOR);

  const estimatedOutputTokens = hasCollection
    ? Math.max(projectedOutput, COLLECTION_OUTPUT_FLOOR_TOKENS)
    : projectedOutput;

  if (!hasCollection) {
    return {
      estimatedPromptTokens,
      estimatedOutputTokens,
      recommendedTimeoutMs: MEDIUM_TIMEOUT_MS,
      // `null` y no una cifra: sin coleccion, el presupuesto que el backend
      // pone solo ante una plantilla base ya cubre esto de sobra, y fijarlo
      // aqui solo serviria para congelarlo.
      recommendedMaxTokens: null,
      recommendedMaxRetries: DEFAULT_LLM_MAX_RETRIES,
      complexityLevel: 'MEDIA',
      source: 'TEMPLATE',
      reason:
        'La plantilla base tiene estructura fija y ninguna coleccion que repetir. El presupuesto que el backend aplica por tener plantilla deberia bastar.',
    };
  }

  const withMargin = roundUpToStep(Math.ceil(estimatedOutputTokens * OUTPUT_SAFETY_MARGIN));

  return {
    estimatedPromptTokens,
    estimatedOutputTokens,
    recommendedTimeoutMs: clamp(HIGH_TIMEOUT_MS, MEDIUM_TIMEOUT_MS, MAX_LLM_TIMEOUT_MS),
    // Aqui SI se sugiere una cifra, porque es el caso en que lo que el backend
    // pondria por su cuenta puede quedarse corto. El suelo es ese mismo valor:
    // recomendar menos seria empeorar la situacion de partida.
    recommendedMaxTokens: clamp(withMargin, DEFAULT_LLM_MARKUP_MAX_TOKENS, MAX_LLM_MAX_TOKENS),
    // Cero: cada reintento volveria a facturar la tabla entera.
    recommendedMaxRetries: 0,
    complexityLevel: 'ALTA',
    source: 'TEMPLATE',
    reason: `La plantilla base repite fichas (${rows} filas detectadas) y el modelo debe devolverla entera y rellena. Es el escenario que agota el presupuesto y corta la respuesta a media cadena JSON.`,
  };
};
