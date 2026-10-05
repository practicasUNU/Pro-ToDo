import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';

import { CODE_PATTERN } from '@modules/ai-prompt-templates/dto/create-ai-prompt-template.dto';
import { LlmProvider } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import { DEFAULT_GEMINI_MODEL } from '@modules/nodes/strategies/providers/gemini-llm.provider';

/** Proveedor por defecto: simulacion de coste cero. Ver la nota de la clase. */
export const DEFAULT_LLM_PROVIDER = LlmProvider.MOCK;

/** Modelo por defecto cuando el nodo no declara uno. */
export const DEFAULT_LLM_MODEL = DEFAULT_GEMINI_MODEL;

/** Espera maxima por defecto de la inferencia: quince segundos. */
export const DEFAULT_LLM_TIMEOUT_MS = 15_000;

/**
 * Suelo del `timeoutMs`.
 *
 * Por debajo de un segundo ningun proveedor termina de generar una redaccion
 * completa, y el nodo se pasaria la vida devolviendo timeouts contra un
 * servicio que funciona.
 */
export const MIN_LLM_TIMEOUT_MS = 1_000;

/**
 * Techo del `timeoutMs`.
 *
 * El motor FSM ejecuta los nodos en linea, asi que este valor es tiempo que el
 * flujo entero pasa bloqueado. Un minuto es el limite a partir del cual conviene
 * dar la inferencia por perdida antes que retener la ejecucion.
 */
export const MAX_LLM_TIMEOUT_MS = 60_000;

/** Reintentos rapidos de red por defecto, adicionales al primer intento. */
export const DEFAULT_LLM_MAX_RETRIES = 3;

/** Techo de reintentos internos. Ver el AVISO sobre los dos niveles. */
export const MAX_LLM_RETRIES = 5;

/**
 * Presupuesto de tokens cuando el nodo debe devolver ademas la plantilla rellena.
 *
 * Solo se aplica en ese caso: ver `resolveMaxTokens` en la estrategia. Un
 * resumen de texto plano cabe de sobra en el defecto de cada proveedor, pero una
 * plantilla institucional completa ENTERA dentro de una cadena JSON no, y el
 * fallo que produce quedarse corto es el peor posible: la respuesta se corta a
 * media cadena, el JSON deja de ser valido y el nodo muere con
 * `ERR_LLM_PROVIDER_CONTRACT` o `ERR_LLM_PROVIDER_TRUNCATED` sin que el mensaje
 * diga que lo que falto fue presupuesto.
 *
 * 8192 y no 4096 por la leccion que ya costo una tanda en el nodo de OCR (ver
 * `DEFAULT_OCR_MAX_TOKENS`): en la gama Gemini 3.x este tope cubre TAMBIEN los
 * tokens de pensamiento, de modo que el modelo puede gastar un millar
 * deliberando antes de escribir un solo caracter de la respuesta. Y una
 * plantilla HTML es bastante mas larga que una transcripcion.
 */
export const DEFAULT_LLM_MARKUP_MAX_TOKENS = 8_192;
export const MIN_LLM_MAX_TOKENS = 256;
export const MAX_LLM_MAX_TOKENS = 32_768;

/** Fallos consecutivos que activan el freno de emergencia por defecto. */
export const DEFAULT_LLM_EMERGENCY_BRAKE_THRESHOLD = 3;

/** Suelo del umbral del freno: uno, es decir, frenar al primer fallo. */
export const MIN_LLM_EMERGENCY_BRAKE_THRESHOLD = 1;

/** Techo del umbral del freno. Mas alla, el freno deja de frenar nada. */
export const MAX_LLM_EMERGENCY_BRAKE_THRESHOLD = 5;

/**
 * Configuracion del nodo `PROCESADOR_IA`.
 *
 * AVISO SOBRE LOS DOS NIVELES DE REINTENTO. `maxRetries` de aqui es el reintento
 * RAPIDO DE RED que aplica `HttpClientService`: cubre el corte de conexion
 * puntual, el `429` por cuota y el `503` del proveedor, y se resuelve en
 * segundos sin persistir nada. Es independiente del `retryPolicy` que el
 * `pipeline_schema` declara para el nodo, que es la politica del motor
 * (`FsmEngineService.canRetry`): esa reintenta el nodo ENTERO, con checkpoint en
 * PostgreSQL y backoff exponencial entre intentos.
 *
 * Las dos capas se MULTIPLICAN, y en este nodo cada vuelta cuesta dinero. Con
 * `maxRetries: 5` aqui y `retryPolicy.maxRetries: 5` en el esquema, un proveedor
 * que responde despacio provoca hasta TREINTA Y SEIS inferencias facturadas por
 * una sola ejecucion del flujo. Por eso se recomienda declarar este nodo en el
 * esquema con `retryPolicy: { maxRetries: 0 }` y dejar el reintento aqui, donde
 * es barato: no reserializa el contexto acumulado en cada vuelta y, sobre todo,
 * queda bajo la vigilancia del freno de emergencia.
 *
 * NO HAY `outputNamespace`. Ya es un campo de `PipelineNodeConfigDto`, validado
 * contra `NODE_OUTPUT_NAMESPACES` y unico por flujo, y `FsmEngineService` lo usa
 * para depositar el `data` que devuelve la estrategia. Declararlo tambien aqui
 * crearia una segunda fuente de verdad que el validador de topologia no ve.
 *
 * TODOS LOS CAMPOS SON OPCIONALES, y esto es una decision sobre QUE significa
 * guardar. `PipelineValidatorService` aplica este `paramsSchema` tanto a flujos
 * como a PLANTILLAS de flujo, y una plantilla es un blueprint sin operativa: sus
 * `params` van vacios a proposito. Con cualquier campo obligatorio aqui, ninguna
 * plantilla podria contener un `PROCESADOR_IA`. La pregunta "esta completo para
 * ejecutarse" vive donde hay informacion para responderla: en
 * `getIncompleteParams`, que se consulta antes de habilitar un flujo.
 */
export class LlmExtractorConfigDto {
  @ApiPropertyOptional({
    description:
      'UUID de la plantilla en `plantillas_prompts_ia`. Tiene prioridad sobre `inlinePrompt`. Uno de los dos es obligatorio al ACTIVAR, que es donde lo exige `getIncompleteParams`.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID('4', { message: 'templatePromptId debe ser un UUID valido.' })
  templatePromptId?: string;

  @ApiPropertyOptional({
    description:
      'Codigo inmutable de la plantilla en `plantillas_prompts_ia`. Alternativa ' +
      'portable a `templatePromptId`: el UUID se regenera en cada clonado de la base ' +
      'y este literal no, asi que es la forma de que una plantilla de flujo o una ' +
      'semilla citen un prompt. Cede ante `templatePromptId` si vienen los dos.',
    example: 'LICITACION_DEFAULT',
  })
  @IsOptional()
  @IsString({ message: 'promptCode debe ser una cadena.' })
  @IsNotEmpty({ message: 'promptCode no puede estar vacio.' })
  @Matches(CODE_PATTERN, {
    message: 'promptCode solo admite mayusculas, digitos y guion bajo.',
  })
  promptCode?: string;

  @ApiPropertyOptional({
    description:
      'Instruccion escrita directamente en el nodo, con marcadores {{namespace.campo}}. Alternativa a `templatePromptId` para prompts que no se reutilizan.',
    example:
      'Redacta una noticia a partir de {{scraped_web.full_article_content}}',
  })
  @IsOptional()
  @IsString({ message: 'inlinePrompt debe ser una cadena.' })
  @IsNotEmpty({ message: 'inlinePrompt no puede estar vacio.' })
  inlinePrompt?: string;

  @ApiPropertyOptional({
    description:
      'Proveedor que ejecuta la inferencia. MOCK, GEMINI y ANTHROPIC tienen cliente; OPENAI degrada al simulador con un aviso en el log.',
    enum: LlmProvider,
    default: DEFAULT_LLM_PROVIDER,
  })
  // El defecto es MOCK y no GEMINI a proposito: un nodo recien creado, al que
  // todavia nadie ha mirado la configuracion, no debe poder gastar dinero por
  // omision. Elegir un proveedor de pago es un acto explicito.
  @IsOptional()
  @IsEnum(LlmProvider, {
    message: `provider debe ser uno de: ${Object.values(LlmProvider).join(', ')}.`,
  })
  provider?: LlmProvider;

  @ApiPropertyOptional({
    description: `Identificador del modelo del proveedor. Por defecto ${DEFAULT_LLM_MODEL}`,
    default: DEFAULT_LLM_MODEL,
  })
  // `@IsString` y no un enum cerrado: los proveedores publican modelos nuevos
  // cada pocas semanas y un enum obligaria a desplegar el backend para poder
  // escribir el nombre del ultimo. Quien rechaza un modelo inexistente es el
  // proveedor, con un 4xx que `HttpClientService` no reintenta.
  @IsOptional()
  @IsString({ message: 'model debe ser una cadena.' })
  @IsNotEmpty({ message: 'model no puede estar vacio.' })
  model?: string;

  @ApiPropertyOptional({
    description:
      'Fuerza la simulacion de coste cero: responde el cliente determinista sin salir a ningun proveedor, sea cual sea `provider`.',
    default: false,
  })
  @IsOptional()
  @IsBoolean({ message: 'dryRun debe ser un booleano.' })
  dryRun?: boolean;

  @ApiPropertyOptional({
    description: `Espera maxima de la inferencia, en milisegundos. Por defecto ${DEFAULT_LLM_TIMEOUT_MS}`,
    default: DEFAULT_LLM_TIMEOUT_MS,
    minimum: MIN_LLM_TIMEOUT_MS,
    maximum: MAX_LLM_TIMEOUT_MS,
  })
  @IsOptional()
  @IsInt({ message: 'timeoutMs debe ser un numero entero.' })
  @Min(MIN_LLM_TIMEOUT_MS, {
    message: `timeoutMs no puede ser menor que ${MIN_LLM_TIMEOUT_MS}.`,
  })
  @Max(MAX_LLM_TIMEOUT_MS, {
    message: `timeoutMs no puede superar ${MAX_LLM_TIMEOUT_MS}.`,
  })
  timeoutMs?: number;

  @ApiPropertyOptional({
    description: `Reintentos rapidos de red, adicionales al primer intento. Por defecto ${DEFAULT_LLM_MAX_RETRIES}. Ver el AVISO sobre los dos niveles de reintento.`,
    default: DEFAULT_LLM_MAX_RETRIES,
    minimum: 0,
    maximum: MAX_LLM_RETRIES,
  })
  @IsOptional()
  @IsInt({ message: 'maxRetries debe ser un numero entero.' })
  @Min(0, { message: 'maxRetries no puede ser negativo.' })
  @Max(MAX_LLM_RETRIES, {
    message: `maxRetries no puede superar ${MAX_LLM_RETRIES}.`,
  })
  maxRetries?: number;

  @ApiPropertyOptional({
    description: `Fallos consecutivos del proveedor que activan el freno de emergencia y pausan el flujo. Por defecto ${DEFAULT_LLM_EMERGENCY_BRAKE_THRESHOLD}`,
    default: DEFAULT_LLM_EMERGENCY_BRAKE_THRESHOLD,
    minimum: MIN_LLM_EMERGENCY_BRAKE_THRESHOLD,
    maximum: MAX_LLM_EMERGENCY_BRAKE_THRESHOLD,
  })
  @IsOptional()
  @IsInt({ message: 'emergencyBrakeThreshold debe ser un numero entero.' })
  @Min(MIN_LLM_EMERGENCY_BRAKE_THRESHOLD, {
    message: `emergencyBrakeThreshold no puede ser menor que ${MIN_LLM_EMERGENCY_BRAKE_THRESHOLD}.`,
  })
  @Max(MAX_LLM_EMERGENCY_BRAKE_THRESHOLD, {
    message: `emergencyBrakeThreshold no puede superar ${MAX_LLM_EMERGENCY_BRAKE_THRESHOLD}.`,
  })
  emergencyBrakeThreshold?: number;

  @ApiPropertyOptional({
    description:
      'Tope de tokens de la respuesta. Omitido, el nodo decide: eleva el presupuesto solo cuando su prompt cita una plantilla base, y por lo demas deja mandar al defecto de cada proveedor.',
    minimum: MIN_LLM_MAX_TOKENS,
    maximum: MAX_LLM_MAX_TOKENS,
  })
  @IsOptional()
  @IsInt({ message: 'maxTokens debe ser un entero.' })
  @Min(MIN_LLM_MAX_TOKENS, {
    message: `maxTokens no puede ser menor que ${MIN_LLM_MAX_TOKENS}.`,
  })
  @Max(MAX_LLM_MAX_TOKENS, {
    message: `maxTokens no puede ser mayor que ${MAX_LLM_MAX_TOKENS}.`,
  })
  maxTokens?: number;
}

/** Configuracion del nodo de IA con los valores por defecto ya aplicados. */
export interface ResolvedLlmExtractorConfig {
  readonly templatePromptId: string | null;
  readonly promptCode: string | null;
  readonly inlinePrompt: string | null;
  readonly provider: LlmProvider;
  readonly model: string;
  readonly dryRun: boolean;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly emergencyBrakeThreshold: number;
  /**
   * `null` significa NO DECLARADO, no "sin tope".
   *
   * Hace falta distinguirlo porque el defecto de este campo no se puede resolver
   * aqui: depende de si el prompt cita una plantilla base, y esta funcion es
   * pura sobre `params` y no ve el prompt ya resuelto. Quien aplica el defecto
   * es `resolveMaxTokens`, en la estrategia.
   */
  readonly maxTokens: number | null;
}

/** Aplica los valores por defecto sobre un DTO ya validado. Funcion pura. */
export const resolveLlmExtractorConfig = (
  dto: LlmExtractorConfigDto,
): ResolvedLlmExtractorConfig => ({
  // `?? null` y no un lanzamiento: el DTO admite la ausencia al guardar, asi que
  // aqui hay que representarla. Quien la convierte en un fallo diagnosticado es
  // la guarda de `resolvePrompt`, que emite ERR_LLM_PROMPT_UNRESOLVED antes de
  // llamar a ningun proveedor.
  templatePromptId: dto.templatePromptId ?? null,
  promptCode: dto.promptCode ?? null,
  inlinePrompt: dto.inlinePrompt ?? null,
  provider: dto.provider ?? DEFAULT_LLM_PROVIDER,
  model: dto.model ?? DEFAULT_LLM_MODEL,
  dryRun: dto.dryRun ?? false,
  timeoutMs: dto.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
  maxRetries: dto.maxRetries ?? DEFAULT_LLM_MAX_RETRIES,
  emergencyBrakeThreshold:
    dto.emergencyBrakeThreshold ?? DEFAULT_LLM_EMERGENCY_BRAKE_THRESHOLD,
  maxTokens: dto.maxTokens ?? null,
});
