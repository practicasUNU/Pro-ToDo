import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

import { INTERPOLATION_ONLY_PATTERN } from '@core/fsm/context/state-payload.context';

/** Espera maxima por defecto para que la pagina cargue: veinte segundos. */
export const DEFAULT_SCRAPER_TIMEOUT_MS = 20_000;

/**
 * Suelo del `timeoutMs`.
 *
 * Por debajo de cinco segundos casi ningun portal de noticias termina de servir
 * el documento, y el nodo se pasaria la vida devolviendo
 * `ERR_SCRAPING_TIMEOUT_EXCEEDED` contra paginas que funcionan.
 */
export const MIN_SCRAPER_TIMEOUT_MS = 5_000;

/**
 * Techo del `timeoutMs`.
 *
 * El motor FSM ejecuta los nodos en linea, asi que este valor es tiempo que el
 * flujo entero pasa bloqueado. Un minuto es el limite a partir del cual conviene
 * dar la pagina por perdida antes que retener la ejecucion.
 */
export const MAX_SCRAPER_TIMEOUT_MS = 60_000;

/** Reintentos rapidos por defecto, adicionales al primer intento. */
export const DEFAULT_SCRAPER_MAX_RETRIES = 2;

/** Techo de reintentos internos. Ver la nota sobre `retryPolicy` mas abajo. */
export const MAX_SCRAPER_RETRIES = 3;

/** Espera por defecto entre reintentos internos: dos segundos. */
export const DEFAULT_SCRAPER_RETRY_DELAY_MS = 2_000;

/** Suelo de la espera entre reintentos. */
export const MIN_SCRAPER_RETRY_DELAY_MS = 500;

/** Techo de la espera entre reintentos. */
export const MAX_SCRAPER_RETRY_DELAY_MS = 10_000;

/**
 * Por defecto, un extractor sin origen se SALTA en vez de romper el flujo.
 *
 * Se elige este defecto porque el modo de fallo que cubre —el correo que no
 * traia enlaces, la contingencia OCR que nunca publica una URL— es rutinario, y
 * convertirlo en una incidencia que alguien tiene que cerrar a mano cuesta mas
 * que el riesgo contrario. El precio esta asumido: un operador que olvide elegir
 * el origen obtiene un flujo que se salta la extraccion en silencio, y por eso
 * el asistente lo avisa de forma no bloqueante en vez de callarselo.
 */
export const DEFAULT_SCRAPER_SKIP_IF_EMPTY = true;

/**
 * Configuracion del nodo `EXTRACTOR_WEB`.
 *
 * AVISO SOBRE LOS DOS NIVELES DE REINTENTO. `maxRetries` y `retryDelayMs` son
 * el reintento RAPIDO DE RED de este nodo: cubren el corte de conexion puntual
 * y el portal que tarda de mas en una peticion concreta, y se resuelven en
 * segundos sin persistir nada. Son independientes del `retryPolicy` que el
 * `pipeline_schema` declara para el nodo, que es la politica del motor
 * (`FsmEngineService.canRetry`): esa reintenta el nodo ENTERO, con checkpoint en
 * PostgreSQL y backoff exponencial entre intentos.
 *
 * Las dos capas se multiplican. Con `maxRetries: 3` aqui y
 * `retryPolicy.maxRetries: 3` en el esquema, una pagina caida provoca hasta
 * DIECISEIS navegaciones y, con el `timeoutMs` por techo, mas de cinco minutos
 * de flujo bloqueado. Por eso se recomienda declarar este nodo en el esquema con
 * `retryPolicy: { maxRetries: 0 }` y dejar que el reintento viva solo aqui,
 * donde es barato: reaprovecha el mismo `BrowserContext` y no reserializa el
 * contexto acumulado en cada vuelta.
 */
export class WebScraperConfigDto {
  @ApiPropertyOptional({
    description:
      'URL del articulo a extraer. Si viene, DEBE ser una variable interpolada contra el contexto acumulado, p. ej. "{{parsed_email.extracted_urls[0]}}". Opcional al GUARDAR (una plantilla de flujo declara topologia, no operativa) y obligatorio al ACTIVAR, que es donde lo exige `getIncompleteParams`.',
    example: '{{parsed_email.extracted_urls[0]}}',
  })
  // OPCIONAL, y esto es una decision sobre QUE significa guardar. Una plantilla
  // de flujo es un blueprint sin operativa: sus `params` van vacios a proposito
  // porque el valor concreto se elige despues, al instanciar el flujo en el
  // asistente. Con el campo obligatorio aqui, `PipelineValidatorService` —que
  // aplica este `paramsSchema` a plantillas y flujos por igual— hacia que
  // NINGUNA plantilla pudiera contener un EXTRACTOR_WEB: los tres constraints
  // saltaban a la vez sobre un `params: {}`.
  //
  // Lo que se valida aqui es la FORMA de lo que haya. Las otras dos preguntas
  // viven donde hay informacion para responderlas:
  //   - "hay de donde sacar una URL en este flujo" -> regla 8 de la topologia,
  //     via `requiredUpstreamFieldTypes`. Un DTO valida un nodo AISLADO y no
  //     puede saber quien va delante.
  //   - "esta completo para ejecutarse" -> `getIncompleteParams`, que consulta
  //     `assertActivatable` antes de habilitar un flujo.
  @IsOptional()
  @IsString({ message: 'targetUrl debe ser una cadena.' })
  @IsNotEmpty({ message: 'targetUrl no puede estar vacio.' })
  // NO se usa `@IsUrl()` y nunca se uso: aqui el valor no es una URL hasta que
  // el contexto lo resuelve. Quien valida el formato es la estrategia, sobre el
  // valor YA interpolado.
  //
  // Lo que SI cambia es que una URL literal deja de admitirse. El motivo es
  // topologico y no de formato: un `targetUrl` literal no menciona ningun
  // namespace, de modo que `getRequiredNamespaces` devuelve un arreglo vacio y
  // la regla 7 del validador de topologia se queda sin nada que comprobar. Ese
  // nodo podia entonces colocarse en cualquier punto del grafo —detras de un
  // TRIGGER_CRON, por ejemplo— y el esquema se guardaba igual. Exigiendo la
  // interpolacion, todo extractor declara de quien depende y esa laguna se
  // cierra en el momento de guardar.
  //
  // Precio asumido y decidido: el flujo que vigilaba siempre la misma portada
  // con una URL fija deja de ser expresable.
  @Matches(INTERPOLATION_ONLY_PATTERN, {
    message:
      'La URL objetivo debe ser una variable interpolada (ej. {{namespace.campo}}).',
  })
  targetUrl?: string;

  @ApiPropertyOptional({
    description: `Espera maxima de carga de la pagina, en milisegundos. Por defecto ${DEFAULT_SCRAPER_TIMEOUT_MS}`,
    default: DEFAULT_SCRAPER_TIMEOUT_MS,
    minimum: MIN_SCRAPER_TIMEOUT_MS,
    maximum: MAX_SCRAPER_TIMEOUT_MS,
  })
  @IsOptional()
  @IsInt({ message: 'timeoutMs debe ser un numero entero.' })
  @Min(MIN_SCRAPER_TIMEOUT_MS, {
    message: `timeoutMs no puede ser menor que ${MIN_SCRAPER_TIMEOUT_MS}.`,
  })
  @Max(MAX_SCRAPER_TIMEOUT_MS, {
    message: `timeoutMs no puede superar ${MAX_SCRAPER_TIMEOUT_MS}.`,
  })
  timeoutMs?: number;

  @ApiPropertyOptional({
    description: `Reintentos rapidos adicionales al primer intento. Por defecto ${DEFAULT_SCRAPER_MAX_RETRIES}`,
    default: DEFAULT_SCRAPER_MAX_RETRIES,
    minimum: 0,
    maximum: MAX_SCRAPER_RETRIES,
  })
  @IsOptional()
  @IsInt({ message: 'maxRetries debe ser un numero entero.' })
  @Min(0, { message: 'maxRetries no puede ser negativo.' })
  @Max(MAX_SCRAPER_RETRIES, {
    message: `maxRetries no puede superar ${MAX_SCRAPER_RETRIES}.`,
  })
  maxRetries?: number;

  @ApiPropertyOptional({
    description: `Espera entre reintentos rapidos, en milisegundos. Por defecto ${DEFAULT_SCRAPER_RETRY_DELAY_MS}`,
    default: DEFAULT_SCRAPER_RETRY_DELAY_MS,
    minimum: MIN_SCRAPER_RETRY_DELAY_MS,
    maximum: MAX_SCRAPER_RETRY_DELAY_MS,
  })
  @IsOptional()
  @IsInt({ message: 'retryDelayMs debe ser un numero entero.' })
  @Min(MIN_SCRAPER_RETRY_DELAY_MS, {
    message: `retryDelayMs no puede ser menor que ${MIN_SCRAPER_RETRY_DELAY_MS}.`,
  })
  @Max(MAX_SCRAPER_RETRY_DELAY_MS, {
    message: `retryDelayMs no puede superar ${MAX_SCRAPER_RETRY_DELAY_MS}.`,
  })
  retryDelayMs?: number;

  @ApiPropertyOptional({
    description:
      'Si es true, un "targetUrl" ausente deja de ser un fallo: el nodo devuelve el payload neutro (las cinco claves en blanco) y el flujo continua. Ademas exime a este nodo de la regla 8 de topologia, de modo que puede declararse en un flujo donde ningun paso anterior publica una URL (contingencia OCR).',
    default: DEFAULT_SCRAPER_SKIP_IF_EMPTY,
  })
  @IsOptional()
  @IsBoolean({ message: 'skipIfEmpty debe ser un booleano.' })
  skipIfEmpty?: boolean;
}

/** Configuracion del extractor con los valores por defecto ya aplicados. */
export interface ResolvedWebScraperConfig {
  readonly targetUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  readonly skipIfEmpty: boolean;
}

/** Aplica los valores por defecto sobre un DTO ya validado. Funcion pura. */
export const resolveWebScraperConfig = (
  dto: WebScraperConfigDto | ResolvedWebScraperConfig,
): ResolvedWebScraperConfig => ({
  // `?? ''` y no un lanzamiento: el DTO admite la ausencia al guardar, asi que
  // aqui hay que representarla. Quien la convierte en un fallo diagnosticado es
  // la guarda de `resolveConfig`, que emite ERR_SCRAPER_CONFIG antes de navegar.
  targetUrl: dto.targetUrl ?? '',
  timeoutMs: dto.timeoutMs ?? DEFAULT_SCRAPER_TIMEOUT_MS,
  maxRetries: dto.maxRetries ?? DEFAULT_SCRAPER_MAX_RETRIES,
  retryDelayMs: dto.retryDelayMs ?? DEFAULT_SCRAPER_RETRY_DELAY_MS,
  skipIfEmpty: dto.skipIfEmpty ?? DEFAULT_SCRAPER_SKIP_IF_EMPTY,
});
