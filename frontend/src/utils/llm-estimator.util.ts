import {
  DEFAULT_LLM_MARKUP_MAX_TOKENS,
  DEFAULT_LLM_MAX_RETRIES,
  DEFAULT_MAX_TOKENS_MULTIPLE,
  isBatchCardinality,
  DEFAULT_LLM_TIMEOUT_MS,
  MAX_LLM_MAX_TOKENS,
  MAX_LLM_TIMEOUT_MS,
} from '@/types/nodes/llm-extractor.types';

// Helper puro de presentacion (frontend-architecture.md §2.1): sin estado, sin
// E/S y sin dependencia de Pinia. Responde a UNA pregunta —cuanto va a costar
// esta inferencia— para que el operador la vea ANTES de ejecutar el flujo y no
// despues, en forma de ERR_HTTP_TIMEOUT o de JSON cortado a media cadena.

import type { LlmOutputCardinality } from '@/types/nodes/llm-extractor.types';

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

  /**
   * El prompt pide generacion EXTENSA (`LONG_FORM_PARAGRAPH_THRESHOLD` parrafos
   * o mas por elemento). Es lo que justifica el presupuesto alto, la espera de
   * tres minutos y el aviso del asistente cuando los campos se quedan cortos.
   */
  readonly longForm: boolean;
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

/**
 * Espera sugerida para una coleccion o un lote.
 *
 * Dos minutos y no uno: un lote devuelve varias piezas enteras, y con 60 s el
 * proveedor cortaba la respuesta antes de cerrar el JSON.
 */
const HIGH_TIMEOUT_MS = 120_000;

/** Espera sugerida para la generacion extensa (el techo del DTO). */
const EXTENDED_TIMEOUT_MS = 180_000;

/**
 * Parrafos por elemento a partir de los cuales la redaccion es EXTENSA.
 *
 * Ocho deja fuera los "minimo de 4" de un lote corto y atrapa las noticias de
 * 12 a 14 parrafos de Notiweb.
 */
export const LONG_FORM_PARAGRAPH_THRESHOLD = 8;

/** Tokens de un parrafo periodistico de longitud media, en espanol. */
const TOKENS_PER_PARAGRAPH = 180;

/**
 * Cada parrafo viaja DOS veces en la respuesta: dentro del marcado
 * (`filled_markup`) y en `body_paragraphs`.
 */
const PARAGRAPH_DUPLICATION = 2;

/** Titular, entradilla, encabezados, referencia y envoltorio JSON. */
const LONG_FORM_OVERHEAD_TOKENS = 1_500;

/** «entre 12 y 14 parrafos», «3 a 4 parrafos», «12-14 parrafos». */
const PARAGRAPH_RANGE_PATTERN = /(\d{1,2})\s*(?:y|a|-|–)\s*(\d{1,2})\s*p[aáAÁ]rrafos/gi;

/** «minimo de 4 parrafos». */
const PARAGRAPH_MINIMUM_PATTERN = /m[iíIÍ]nimo\s+de\s+(\d{1,2})\s+p[aáAÁ]rrafos/gi;

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
/**
 * Factor de lote: un correo con varias piezas devuelve la raiz MAS un elemento
 * por pieza adicional. Tres es un boletin corto; el suelo de abajo cubre el
 * caso de un elemento grande (una plantilla HTML entera por noticia).
 */
const BATCH_OUTPUT_FACTOR = 3;

/** Suelo de la salida proyectada de un lote: el presupuesto de un elemento. */
const BATCH_MIN_OUTPUT_TOKENS = 8_192;

const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

/**
 * Mayor numero de parrafos POR ELEMENTO que pide el prompt, o 0.
 *
 * Se queda con el extremo superior de cada rango y con cada minimo declarado:
 * lo que importa para el presupuesto es lo maximo que el modelo puede escribir.
 */
export const requestedParagraphs = (promptText: string | null | undefined): number => {
  if (promptText === null || promptText === undefined || promptText.trim() === '') {
    return 0;
  }

  let requested = 0;

  for (const match of promptText.matchAll(PARAGRAPH_RANGE_PATTERN)) {
    requested = Math.max(requested, Number(match[2]));
  }

  for (const match of promptText.matchAll(PARAGRAPH_MINIMUM_PATTERN)) {
    requested = Math.max(requested, Number(match[1]));
  }

  return requested;
};

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
    longForm: false,
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
  cardinality: LlmOutputCardinality = 'SINGLE',
  promptText: string | null = null,
): LlmResourceEstimate => {
  const single = estimateSingleItem(baseMarkup, upstreamFieldCount);

  // `AUTO` se estima como un lote: el numero de elementos no se conoce hasta
  // que responde el modelo, y el backend le reserva el presupuesto de lote.
  const isBatch = isBatchCardinality(cardinality);
  const base = isBatch ? scaleForBatch(single) : single;
  const paragraphs = requestedParagraphs(promptText);

  return paragraphs >= LONG_FORM_PARAGRAPH_THRESHOLD
    ? applyLongForm(base, paragraphs, isBatch)
    : base;
};

/**
 * Ajusta la estimacion a una redaccion EXTENSA pedida por el propio prompt.
 *
 * El marcado no lo delata: una plantilla de noticia es corta y vacia, y lo que
 * la llena son los parrafos que el prompt exige. Se proyectan a partir de ese
 * numero, duplicados porque viajan en el marcado y en `body_paragraphs`, y con
 * lote se escalan por el mismo factor que el resto de la estimacion.
 *
 * UN reintento y no cero: con generacion larga un corte de red a mitad es mas
 * probable, y el reintento es lo que la salva. Y no mas de uno: cada vuelta
 * repite la espera entera y vuelve a facturar la salida.
 */
const applyLongForm = (
  base: LlmResourceEstimate,
  paragraphs: number,
  isBatch: boolean,
): LlmResourceEstimate => {
  const perItem =
    paragraphs * TOKENS_PER_PARAGRAPH * PARAGRAPH_DUPLICATION + LONG_FORM_OVERHEAD_TOKENS;
  const estimatedOutputTokens = Math.max(
    base.estimatedOutputTokens,
    isBatch ? perItem * BATCH_OUTPUT_FACTOR : perItem,
  );

  return {
    ...base,
    estimatedOutputTokens,
    recommendedTimeoutMs: clamp(EXTENDED_TIMEOUT_MS, MEDIUM_TIMEOUT_MS, MAX_LLM_TIMEOUT_MS),
    recommendedMaxTokens: clamp(
      roundUpToStep(Math.ceil(estimatedOutputTokens * OUTPUT_SAFETY_MARGIN)),
      isBatch ? DEFAULT_MAX_TOKENS_MULTIPLE : DEFAULT_LLM_MARKUP_MAX_TOKENS,
      MAX_LLM_MAX_TOKENS,
    ),
    recommendedMaxRetries: DEFAULT_LLM_MAX_RETRIES,
    complexityLevel: 'ALTA',
    longForm: true,
    reason: `Generacion extensa: el prompt pide hasta ${paragraphs} parrafos por noticia${isBatch ? ', en lote' : ''}, que viajan dos veces (marcado y "body_paragraphs"). Se proyectan unos ${estimatedOutputTokens} tokens de salida. Con ${EXTENDED_TIMEOUT_MS / 1000} s y un reintento, el peor caso son ${(EXTENDED_TIMEOUT_MS * 2) / 60_000} min por proveedor.`,
  };
};

/**
 * Escala una estimacion de un elemento a un lote (cardinalidad 1 a N).
 *
 * La salida proyectada se multiplica por el factor de lote con un suelo de
 * 8192 tokens, y se recomienda al menos el presupuesto de lote del backend
 * (16384), hasta el techo de 32768. Dos minutos de espera y UN reintento: un
 * lote tarda, y un corte de red a mitad perderia todas sus piezas; mas de uno
 * repetiria la espera y la factura del lote entero sin necesidad.
 */
const scaleForBatch = (single: LlmResourceEstimate): LlmResourceEstimate => {
  const estimatedOutputTokens = Math.max(
    single.estimatedOutputTokens * BATCH_OUTPUT_FACTOR,
    BATCH_MIN_OUTPUT_TOKENS,
  );

  return {
    ...single,
    estimatedOutputTokens,
    recommendedTimeoutMs: clamp(HIGH_TIMEOUT_MS, MEDIUM_TIMEOUT_MS, MAX_LLM_TIMEOUT_MS),
    recommendedMaxTokens: clamp(
      roundUpToStep(Math.ceil(estimatedOutputTokens * OUTPUT_SAFETY_MARGIN)),
      DEFAULT_MAX_TOKENS_MULTIPLE,
      MAX_LLM_MAX_TOKENS,
    ),
    recommendedMaxRetries: DEFAULT_LLM_MAX_RETRIES,
    complexityLevel: 'ALTA',
    reason: `Modo lote (1:N): la respuesta trae un elemento por cada pieza del correo y se factura entera. Se proyectan unos ${estimatedOutputTokens} tokens de salida; un reintento como maximo, porque cada vuelta repite la espera y la factura. ${single.reason}`,
  };
};

/** Estimacion de UN elemento: la de siempre, a partir de la plantilla o del prompt. */
const estimateSingleItem = (
  baseMarkup: string | null,
  upstreamFieldCount: number,
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
      longForm: false,
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
    longForm: false,
    reason: `La plantilla base repite fichas (${rows} filas detectadas) y el modelo debe devolverla entera y rellena. Es el escenario que agota el presupuesto y corta la respuesta a media cadena JSON.`,
  };
};
