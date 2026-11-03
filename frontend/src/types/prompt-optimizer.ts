/**
 * Asistente "Mejorar Prompt con IA". Replicas de `OptimizePromptDto` y
 * `OptimizePromptResponseDto` del backend (`modules/prompts/dto`).
 */

/** Formatos de salida que sabe optimizar. Replica de `PROMPT_TARGET_FORMATS`. */
export type PromptTargetFormat = 'html' | 'text' | 'markdown' | 'json';

/**
 * Cardinalidad del prompt. Replica de `PromptCardinality`: con `MULTIPLE` el
 * prompt optimizado exige el contrato de lote (raiz = primero, `items` = resto).
 */
export type PromptCardinality = 'SINGLE' | 'MULTIPLE';

export interface OptimizePromptPayload {
  readonly draftPrompt: string;
  readonly targetFormat: PromptTargetFormat;
  /** Modelo del catalogo; sin el, el backend usa el de texto del entorno. */
  readonly model?: string;
  /** Sin ella, el backend asume `SINGLE`. */
  readonly cardinality?: PromptCardinality;
}

/** Consumo de la optimizacion, ya registrado en la telemetria. */
export interface PromptOptimizationTelemetry {
  readonly tokensPrompt: number;
  readonly tokensCompletion: number;
  readonly tokensReasoning: number;
  readonly estimatedCostUSD: number;
  /** `true` si el coste es aproximado (tarifa generica o uso no informado). */
  readonly isEstimated: boolean;
  readonly provider: string;
  readonly model: string;
}

/** Variables del prompt optimizado como rutas `ns.campo`, separadas por necesidad. */
export interface RecommendedPromptVariables {
  /** Marcadas `{{*ns.campo}}`: si faltan, el flujo se pausa antes de la IA. */
  readonly mandatory: string[];
  /** Marcadas `{{ns.campo}}`: si faltan, se sustituyen por texto vacio. */
  readonly optional: string[];
}

export interface PromptOptimizationResult {
  readonly optimizedPrompt: string;
  readonly recommendedVariables: RecommendedPromptVariables;
  /** Diagnostico del borrador y justificacion de las obligatorias. */
  readonly rationale: string;
  readonly recommendations: string[];
  readonly telemetry: PromptOptimizationTelemetry;
}
