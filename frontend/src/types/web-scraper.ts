import type { NodeErrorSeverity } from '@/types/pipeline';

// Replica de los contratos del nodo EXTRACTOR_WEB. Fuentes en el backend:
//  - `WebScraperConfigDto`  -> @modules/nodes/dto/web-scraper-config.dto.ts
//  - `ScrapedWebPreviewDto` -> @modules/wizard/dto/check-scraper-response.dto.ts
//  - `CheckScraperDto`      -> @modules/wizard/dto/check-scraper.dto.ts
// Cualquier cambio alli debe reflejarse aqui.
//
// Fichero propio y no dentro de `@/types/pipeline`, por el mismo criterio que
// `@/types/parser-email`: aquel declara ser "replica exacta de los contratos del
// motor FSM", y esto no lo es. El payload vive en `@modules/nodes` justamente
// porque el motor no debe conocer la forma de un articulo web.

/**
 * Payload determinista que el nodo deposita en `scraped_web`.
 *
 * Las claves van en `snake_case` porque asi viajan: son las que una plantilla
 * interpola como `{{scraped_web.full_article_content}}`, y camelizarlas aqui
 * haria que el banco de pruebas mostrase nombres que ninguna plantilla puede
 * escribir.
 */
export interface ScrapedWebPayload {
  /** `null` cuando el nodo se omitio por `skipIfEmpty` y no navego a nada. */
  readonly source_url: string | null;
  readonly article_title: string;
  readonly full_article_content: string;
  /** `null` es "sin firma", distinto de una cadena vacia. */
  readonly byline: string | null;
  readonly scraped_at: string;
}

/**
 * `params` que el nodo EXTRACTOR_WEB aporta al `pipeline_schema`.
 *
 * Los tres numericos son opcionales en el backend, que aplica sus defectos;
 * aqui se mantienen obligatorios dentro del store para que el formulario no
 * tenga que lidiar con campos indefinidos, y es `toNodeParams()` quien decide
 * cuales llegan a publicarse.
 */
export interface WebScraperConfigDto {
  targetUrl: string;
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  /**
   * Un `targetUrl` ausente deja de ser un fallo: el nodo publica el payload
   * neutro y el flujo continua. Exime ademas al nodo de la regla 8 de
   * topologia, de modo que puede declararse donde ningun paso anterior publica
   * una URL (contingencia OCR).
   */
  skipIfEmpty: boolean;
  /**
   * Dominios que el nodo NUNCA navega, comparados contra el host de la URL ya
   * resuelta e incluyendo subdominios.
   *
   * Es lo que permite expresar "el enlace que no sea del portal propio" cuando
   * `targetUrl` apunta al arreglo entero (`{{parsed_email.extracted_urls}}`).
   * Vacio por defecto: el backend no cablea el dominio de ningun cliente.
   */
  excludedDomains: string[];
}

/**
 * Cuerpo de `POST /api/wizard/check-scraper`.
 *
 * `targetUrl` es aqui una URL REAL y absoluta, NO una plantilla `{{...}}`: este
 * endpoint no tiene contexto contra el que interpolar, y el backend la valida
 * con `@IsUrl`. Es el unico punto donde el banco de pruebas y la configuracion
 * del nodo se separan.
 */
export interface CheckScraperPayload {
  readonly targetUrl: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
}

/**
 * Metricas del intento. Llegan tambien cuando la extraccion fracasa.
 *
 * Sin el tiempo real medido, el operador calibra `timeoutMs` y `maxRetries` a
 * ojo, que es justo lo que el banco de pruebas viene a evitar.
 */
export interface CheckScraperMetrics {
  readonly elapsedMs: number;
  readonly attempts: number;
  readonly redirected: boolean;
  readonly contentLength: number;
}

/**
 * Resultado del banco de pruebas del extractor.
 *
 * Un portal caido o un muro de pago NO llegan como error de la peticion, sino
 * como 200 con `success: false`: el diagnostico del portal ES la respuesta que
 * el asistente tiene que mostrar.
 */
export interface CheckScraperResult {
  readonly success: boolean;
  readonly preview?: ScrapedWebPayload;
  readonly metrics?: CheckScraperMetrics;
  readonly warnings?: readonly string[];
  readonly error?: {
    readonly level: NodeErrorSeverity;
    /** Codigo estable (`ERR_SCRAPER_*`). Es el vocabulario del diagnostico. */
    readonly code: string;
    readonly message: string;
  };
}
