import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

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
  @ApiProperty({
    description:
      'URL del articulo a extraer. Admite interpolacion contra el contexto acumulado, p. ej. "{{parsed_email.extracted_urls[0]}}".',
    example: '{{parsed_email.extracted_urls[0]}}',
  })
  @IsString({ message: 'targetUrl debe ser una cadena.' })
  @IsNotEmpty({ message: 'targetUrl no puede estar vacio.' })
  // NO se usa `@IsUrl()`: el valor habitual es una plantilla `{{ns.campo}}`, que
  // no es una URL hasta que el contexto la resuelve. La validacion del formato
  // se hace en la estrategia, sobre el valor YA interpolado.
  targetUrl!: string;

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
}

/** Configuracion del extractor con los valores por defecto ya aplicados. */
export interface ResolvedWebScraperConfig {
  readonly targetUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
}

/** Aplica los valores por defecto sobre un DTO ya validado. Funcion pura. */
export const resolveWebScraperConfig = (
  dto: WebScraperConfigDto | ResolvedWebScraperConfig,
): ResolvedWebScraperConfig => ({
  targetUrl: dto.targetUrl,
  timeoutMs: dto.timeoutMs ?? DEFAULT_SCRAPER_TIMEOUT_MS,
  maxRetries: dto.maxRetries ?? DEFAULT_SCRAPER_MAX_RETRIES,
  retryDelayMs: dto.retryDelayMs ?? DEFAULT_SCRAPER_RETRY_DELAY_MS,
});
