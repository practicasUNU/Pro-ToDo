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

import { clamp } from '@common/utils/clamp.util';
import {
  applyEnvironmentCeiling,
  applyEnvironmentFloor,
} from '@common/utils/env-precedence.util';
import { CODE_PATTERN } from '@modules/ai-prompt-templates/dto/create-ai-prompt-template.dto';
import { LlmProvider } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import { DEFAULT_GEMINI_MODEL } from '@modules/nodes/strategies/providers/gemini-llm.provider';

import type { AiHttpDefaults } from '@core/config/ai-defaults.config';

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
 * flujo entero pasa bloqueado, y por eso el DEFECTO sigue siendo prudente. El
 * techo, en cambio, ya no puede ser un minuto: redactar una plantilla
 * institucional a partir de una tabla de trece comisiones universitarias se
 * pasa de largo de ese minuto, y con el tope ahi el operador no tenia forma de
 * arreglarlo sin desplegar. Son los mismos 120 000 ms que ya admite
 * `MAX_OCR_TIMEOUT_MS`, de modo que los dos nodos que llaman a un modelo
 * comparten limite.
 */
export const MAX_LLM_TIMEOUT_MS = 120_000;

/**
 * Reintentos rapidos de red por defecto, adicionales al primer intento.
 *
 * UNO, y antes eran tres. El motivo es que un `ERR_HTTP_TIMEOUT` SI se
 * reintenta (`HttpClientService.isRetryable` solo excluye el rechazo de
 * cliente), de modo que la espera no se gasta una vez sino
 * `timeoutMs × (maxRetries + 1)` — y el ciclo entero se repite ademas por cada
 * proveedor de la cadena de respaldo, porque `ERR_HTTP_TIMEOUT` tambien es
 * `isFallbackWorthy`. Con el techo nuevo y tres reintentos, un proveedor mudo
 * retenia el motor alrededor de OCHO minutos antes de rendirse.
 *
 * Con uno son dos intentos por proveedor y el salto al siguiente llega antes,
 * que es lo que de verdad resuelve un proveedor saturado: insistir contra el
 * mismo no lo descongestiona.
 */
export const DEFAULT_LLM_MAX_RETRIES = 1;

/**
 * Techo de reintentos internos. Ver el AVISO sobre los dos niveles.
 *
 * TRES y no cinco: el motor ejecuta los nodos EN LINEA, asi que el tiempo que
 * una ejecucion pasa bloqueada es `timeoutMs x (maxRetries + 1)` y se repite
 * ademas por cada proveedor de la cadena de respaldo. Con el techo de espera de
 * este nodo, cinco reintentos retenian el mutex del flujo durante mas de diez
 * minutos por proveedor, y lo que resuelve un proveedor saturado no es insistir
 * contra el sino saltar al siguiente.
 *
 * El suelo sigue siendo CERO y no uno: apagar los reintentos es una
 * configuracion legitima —y la mas barata frente a un proveedor de pago—, asi
 * que exigir al menos uno quitaria la unica forma de expresarla.
 */
export const MAX_LLM_RETRIES = 3;

/**
 * Espera base entre reintentos de la inferencia, en milisegundos.
 *
 * NO es un campo del DTO, y la omision es deliberada: no es una decision del
 * operador sino la distancia minima que el proveedor necesita entre dos
 * intentos. Los 500 ms que `HttpClientService` aplica por defecto estan
 * pensados para un portal web cualquiera; contra un modelo de pago que acaba de
 * devolver un 429 de cuota, medio segundo garantiza caer en el mismo limite y
 * gastar el reintento sin opcion de que funcione.
 *
 * Con `HTTP_BACKOFF_FACTOR` (2) produce esperas de 2 500 / 5 000 / 10 000 ms.
 */
export const LLM_RETRY_BASE_DELAY_MS = 2_500;

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

/**
 * Presupuestos por defecto segun la cardinalidad de la salida.
 *
 * `SINGLE` hereda los 8192 del maquetado (ver arriba). `MULTIPLE` los duplica:
 * un lote devuelve la raiz MAS un elemento por cada pieza adicional del
 * correo, cada uno con su propio `filled_markup`, y quedarse corto corta el
 * JSON a media cadena. El techo es el mismo que valida el DTO.
 */
export const DEFAULT_MAX_TOKENS_SINGLE = DEFAULT_LLM_MARKUP_MAX_TOKENS;
export const DEFAULT_MAX_TOKENS_MULTIPLE = 16_384;
export const MAX_HARD_CEILING_TOKENS = MAX_LLM_MAX_TOKENS;

/**
 * Cardinalidad de la salida del nodo de IA.
 *
 * `SINGLE` es el contrato de siempre: un elemento en la raiz del JSON.
 * `MULTIPLE` anade `items` con el reparto asimetrico (raiz = primer elemento,
 * `items` = el resto), para correos que traen un lote: un boletin con varias
 * noticias, varios expedientes o varios paneles de evaluacion.
 * `AUTO` es la variante tolerante: mismo esquema que `MULTIPLE`, pero el modelo
 * decide si el material trae uno o varios elementos, y la cardinalidad efectiva
 * se resuelve al contar lo que devolvio (`resolved_cardinality`).
 */
export enum LlmOutputCardinality {
  SINGLE = 'SINGLE',
  MULTIPLE = 'MULTIPLE',
  AUTO = 'AUTO',
}

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
    example: 'LICITACION_APERTURA_DEFAULT',
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

  @ApiPropertyOptional({
    description:
      'SINGLE (por defecto): un elemento. MULTIPLE: la respuesta admite un lote, con el primer elemento en la raiz y el resto en "items". AUTO: como MULTIPLE, pero el modelo detecta si hay uno o varios elementos.',
    enum: LlmOutputCardinality,
    default: LlmOutputCardinality.SINGLE,
  })
  @IsOptional()
  @IsEnum(LlmOutputCardinality, {
    message: `outputCardinality debe ser uno de: ${Object.values(LlmOutputCardinality).join(', ')}.`,
  })
  outputCardinality?: LlmOutputCardinality;
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

  /**
   * Espera base del backoff entre reintentos.
   *
   * Viaja en la configuracion resuelta aunque sea constante para que exista UN
   * solo sitio donde se decide la politica de red del nodo: la estrategia lee
   * `config.*` para los otros dos valores, y sacar este de una constante
   * importada aparte repartiria la misma decision en dos capas.
   */
  readonly baseDelayMs: number;
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
  readonly outputCardinality: LlmOutputCardinality;
}

/**
 * Aplica los valores por defecto sobre un DTO ya validado. Funcion pura.
 *
 * `env` es el ESCALON INTERMEDIO de la politica de red, y la precedencia es
 * `params del nodo > entorno > constante`: un nodo que declara su `timeoutMs`
 * sigue mandando sobre el `.env`, igual que ya ocurre con el proveedor y el
 * modelo (`AiDefaultsConfig`). Lleva valor por defecto para que la funcion
 * siga siendo invocable con un solo argumento alli donde no hay entorno que
 * consultar —validadores, asistente, pruebas—.
 */
export const resolveLlmExtractorConfig = (
  dto: LlmExtractorConfigDto,
  env: AiHttpDefaults = { timeoutMs: null, maxRetries: null },
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
  // PISO, no defecto: ver `applyEnvironmentFloor`. El asistente publica
  // `timeoutMs` en el esquema aunque el operador no lo haya tocado, asi que un
  // flujo guardado con los 15 000 de antes ganaba a un `.env` que pide 60 000 y
  // la variable no alcanzaba a los unicos flujos que la necesitan.
  //
  // El `clamp` sigue haciendo falta por el valor del ENTORNO: lo que viene en
  // `dto` ya paso por los `@Min`/`@Max` de arriba, pero una variable del `.env`
  // no atraviesa `class-validator` en ninguna parte. Se recorta y no se rechaza
  // porque un `.env` con una errata no debe impedir que el flujo corra.
  timeoutMs: clamp(
    applyEnvironmentFloor(dto.timeoutMs, env.timeoutMs, DEFAULT_LLM_TIMEOUT_MS),
    MIN_LLM_TIMEOUT_MS,
    MAX_LLM_TIMEOUT_MS,
  ),
  // TECHO y no piso, al reves que la espera: aqui pasarse cuesta dinero. Ver el
  // TSDoc de `applyEnvironmentCeiling`.
  maxRetries: clamp(
    applyEnvironmentCeiling(
      dto.maxRetries,
      env.maxRetries,
      DEFAULT_LLM_MAX_RETRIES,
    ),
    0,
    MAX_LLM_RETRIES,
  ),
  baseDelayMs: LLM_RETRY_BASE_DELAY_MS,
  emergencyBrakeThreshold:
    dto.emergencyBrakeThreshold ?? DEFAULT_LLM_EMERGENCY_BRAKE_THRESHOLD,
  maxTokens: dto.maxTokens ?? null,
  outputCardinality: dto.outputCardinality ?? LlmOutputCardinality.SINGLE,
});
