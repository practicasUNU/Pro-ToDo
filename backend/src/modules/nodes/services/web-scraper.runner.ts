import { Injectable, Logger } from '@nestjs/common';
// Import de VALOR: `errors.TimeoutError` se usa en un `instanceof`, que no
// sobrevive a un `import type`.
import { errors as playwrightErrors } from 'playwright';

import { BrowserPoolService } from '@modules/nodes/services/browser-pool.service';
import { extractArticle } from '@modules/nodes/utils/article-extractor.util';

import type {
  ArticleExtractionHooks,
  ExtractedArticle,
} from '@modules/nodes/utils/article-extractor.util';
import type { BrowserContext, Page } from 'playwright';

/**
 * Codigos de fallo de la NAVEGACION y la extraccion.
 *
 * Viven aqui y no en la estrategia porque son lo que produce esta clase; la
 * estrategia los reexpone tal cual en su `NodeResult`, y el banco de pruebas del
 * asistente los devuelve en su respuesta. Que haya UNA sola definicion es lo que
 * garantiza que el `catchErrors` de un esquema y el mensaje que el operador ve
 * al probar hablen del mismo fallo.
 */
export const ERR_SCRAPING_TIMEOUT_EXCEEDED = 'ERR_SCRAPING_TIMEOUT_EXCEEDED';
export const ERR_EXTERNAL_SERVER_UNREACHABLE =
  'ERR_EXTERNAL_SERVER_UNREACHABLE';
export const ERR_ACCESS_DENIED_BLOCK_DETECTED =
  'ERR_ACCESS_DENIED_BLOCK_DETECTED';
export const ERR_SCRAPER_EMPTY_CONTENT = 'ERR_SCRAPER_EMPTY_CONTENT';

/** Parametros de navegacion, ya con los valores por defecto aplicados. */
export interface ScrapeOptions {
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
}

/** Extraccion lograda, con la URL final tras las redirecciones. */
export interface ScrapeSuccess {
  readonly success: true;
  readonly sourceUrl: string;
  readonly article: ExtractedArticle;
  /** Navegaciones consumidas, incluida la que tuvo exito. */
  readonly attempts: number;
}

/** Extraccion fallida, ya clasificada. */
export interface ScrapeFailure {
  readonly success: false;
  readonly code: string;
  readonly message: string;
  readonly stackTrace?: string;
  /** URL final alcanzada, si se llego a navegar. */
  readonly sourceUrl?: string;
  readonly attempts: number;
}

/** Union discriminada: o hay articulo, o hay un fallo con su codigo. */
export type ScrapeOutcome = ScrapeSuccess | ScrapeFailure;

/**
 * Margen de cortesia para que el contenido diferido se pinte tras el DOM.
 *
 * Tiene su PROPIO presupuesto, separado de `timeoutMs`, porque es opcional: si
 * vence se extrae lo que ya hubiera, y nunca es causa de fallo.
 */
const NETWORK_SETTLE_TIMEOUT_MS = 3_000;

/**
 * Codigos de red de Chromium que son, en realidad, una espera agotada.
 *
 * NO son `TimeoutError` de Playwright: el vencimiento lo declara la pila de red
 * del navegador y no el reloj de la operacion. Sin esta lista, un servidor que
 * acepta la conexion y luego calla se clasificaria como inalcanzable, que es
 * justo lo contrario de lo que paso.
 */
const TIMEOUT_NET_ERROR_CODES: ReadonlySet<string> = new Set([
  'ERR_TIMED_OUT',
  'ERR_CONNECTION_TIMED_OUT',
]);

/** Extrae el `net::ERR_*` que Chromium incrusta en el mensaje de `page.goto`. */
const NET_ERROR_PATTERN = /net::(ERR_[A-Z0-9_]+)/;

/**
 * Estados HTTP que son un "no" explicito del servidor.
 *
 * `429` entra tambien como bloqueo y no como fallo reintentable: insistir contra
 * un limite de tasa solo empeora la reputacion de la IP corporativa.
 */
const BLOCKING_HTTP_STATUSES: ReadonlySet<number> = new Set([
  401, 402, 403, 407, 429,
]);

/**
 * Marcas en la URL FINAL, ya resuelta la cadena de redirecciones.
 *
 * Es la senal mas barata y la mas fiable: un sitio que exige sesion no falla,
 * REDIRIGE. Se comprueban sobre la ruta y la query, nunca sobre el host, para que
 * un dominio llamado `loginformativo.es` no se descarte por su nombre.
 */
const BLOCKING_URL_PATTERNS: readonly RegExp[] = [
  /\/(?:login|signin|sign-in|iniciar-sesion|acceso)\b/i,
  /\/(?:register|registro|signup|sign-up)\b/i,
  /\/(?:subscribe|suscri\w*|paywall|premium|checkout)\b/i,
  /\/(?:captcha|challenge)\b/i,
  /cdn-cgi\/challenge/i,
];

/** Titulos que los intersticiales anti-bot emiten literalmente. */
const BLOCKING_TITLE_PATTERNS: readonly RegExp[] = [
  /just a moment/i,
  /attention required/i,
  /access denied/i,
  /acceso denegado/i,
  /verify (?:you are|that you are) (?:a )?human/i,
  /are you a robot/i,
];

/** Elementos que delatan el muro aunque la URL y el titulo sean inocentes. */
const BLOCKING_SELECTORS = [
  'input[type="password"]',
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  '.g-recaptcha',
  '.h-captcha',
  '.cf-turnstile',
  '[id*="paywall" i]',
  '[class*="paywall" i]',
  '[class*="subscription-wall" i]',
  '[class*="regwall" i]',
].join(', ');

/** Mensaje legible de cualquier cosa lanzable. */
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Traza completa del error, si la hay, lista para fusionar en el detalle. */
const stackTraceOf = (error: unknown): { stackTrace?: string } =>
  error instanceof Error && error.stack !== undefined
    ? { stackTrace: error.stack }
    : {};

/**
 * Traduce un fallo de navegacion a su codigo.
 *
 * Se comprueba `name` ADEMAS de `instanceof`: el primero es lo unico que un doble
 * de prueba puede reproducir sin cargar el runtime de Playwright, y el segundo es
 * lo unico fiable si otra libreria emitiera algun dia un error homonimo.
 *
 * El orden importa. Primero el vencimiento del reloj de la operacion, luego los
 * `net::ERR_*` que son vencimientos disfrazados, y solo despues el cajon de
 * "servidor inalcanzable", que recoge tambien lo no clasificado: un fallo de
 * navegacion sin identificar es, a efectos del operador, un destino al que no se
 * llego.
 */
export const classifyNavigationError = (error: unknown): string => {
  if (
    error instanceof playwrightErrors.TimeoutError ||
    (error instanceof Error && error.name === 'TimeoutError')
  ) {
    return ERR_SCRAPING_TIMEOUT_EXCEEDED;
  }

  const netCode = NET_ERROR_PATTERN.exec(messageOf(error))?.[1];

  if (netCode !== undefined && TIMEOUT_NET_ERROR_CODES.has(netCode)) {
    return ERR_SCRAPING_TIMEOUT_EXCEEDED;
  }

  return ERR_EXTERNAL_SERVER_UNREACHABLE;
};

/**
 * Navegacion, deteccion de bloqueo y extraccion de un articulo.
 *
 * SE EXTRAJO DE `WebScraperStrategy` para que el banco de pruebas del asistente
 * (`POST /api/wizard/check-scraper`) recorra EXACTAMENTE el mismo camino que la
 * ejecucion real. Es el mismo argumento que documenta `parser-email.strategy.ts`
 * sobre `buildParsedEmail`: si el asistente navegase por su cuenta, el operador
 * probaria una cosa y el flujo haria otra, y la discrepancia aparecereria justo
 * en el caso que mas importa —el portal que bloquea—, que es el que nadie puede
 * reproducir a mano.
 *
 * Lo que NO vive aqui: la validacion de `params`, la interpolacion de la URL
 * contra el contexto y la traduccion a `NodeResult`. Eso es contrato del nodo y
 * se queda en la estrategia; el asistente no tiene contexto que interpolar ni
 * `NodeResult` que devolver.
 */
@Injectable()
export class WebScraperRunner {
  private readonly logger = new Logger(WebScraperRunner.name);

  constructor(private readonly browserPool: BrowserPoolService) {}

  /**
   * Extrae el articulo de `url`.
   *
   * NUNCA lanza: todo fallo sale como `ScrapeFailure` con su codigo. Un
   * `BrowserContext` por invocacion, reutilizado entre reintentos, cerrado
   * siempre en el `finally`.
   */
  public async run(
    url: URL,
    options: ScrapeOptions,
    hooks: ArticleExtractionHooks = {},
  ): Promise<ScrapeOutcome> {
    let browserContext: BrowserContext | null = null;

    try {
      browserContext = await this.browserPool.createContext();
      const page = await browserContext.newPage();

      return await this.navigateWithRetries(page, url, options, hooks);
    } catch (error) {
      // Cubre tambien `createContext()` y `newPage()`.
      return {
        success: false,
        code: classifyNavigationError(error),
        message: `No se pudo extraer "${url.toString()}": ${messageOf(error)}`,
        attempts: 0,
        ...stackTraceOf(error),
      };
    } finally {
      await this.closeQuietly(browserContext);
    }
  }

  /**
   * Bucle de reintento RAPIDO DE RED.
   *
   * Cubre el corte puntual de conexion y el portal que tarda de mas en una
   * peticion concreta. Es ortogonal al `retryPolicy` del `pipeline_schema`, que
   * reejecuta el nodo ENTERO con checkpoint en PostgreSQL: las dos capas se
   * MULTIPLICAN, asi que el nodo debe declararse en el esquema con
   * `retryPolicy: { maxRetries: 0 }` (ver el TSDoc de `WebScraperConfigDto`).
   */
  private async navigateWithRetries(
    page: Page,
    url: URL,
    options: ScrapeOptions,
    hooks: ArticleExtractionHooks,
  ): Promise<ScrapeOutcome> {
    const href = url.toString();
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
      try {
        const response = await page.goto(href, {
          timeout: options.timeoutMs,
          // `domcontentloaded` y NO `networkidle`. El propio Playwright
          // desaconseja el segundo: una pagina con sondeo, WebSocket, anuncios o
          // analitica nunca alcanza los 500 ms sin peticiones, y `goto` acabaria
          // lanzando un `TimeoutError` sobre un documento que cargo
          // perfectamente. Ese falso timeout ademas gastaria los reintentos
          // antes de dejar el flujo PAUSADO, y nadie sabria que el HTML estaba
          // ahi.
          waitUntil: 'domcontentloaded',
        });

        // Asentamiento de la red como cortesia, con presupuesto propio: si vence
        // se extrae lo que ya hubiera pintado.
        await page
          .waitForLoadState('networkidle', {
            timeout: NETWORK_SETTLE_TIMEOUT_MS,
          })
          .catch(() => undefined);

        const finalUrl = page.url();
        const blockReason = await this.detectBlock(
          page,
          response?.status() ?? null,
          finalUrl,
        );

        // Un muro no se cae por insistir: se corta el bucle sin reintentar, que
        // solo gastaria otro `timeoutMs` y reforzaria el limite de tasa del
        // portal.
        if (blockReason !== null) {
          return {
            success: false,
            code: ERR_ACCESS_DENIED_BLOCK_DETECTED,
            message: `Acceso denegado en "${finalUrl}": ${blockReason}.`,
            sourceUrl: finalUrl,
            attempts: attempt + 1,
          };
        }

        return this.buildOutcome(
          await page.content(),
          finalUrl,
          attempt + 1,
          hooks,
        );
      } catch (error) {
        lastError = error;

        if (attempt === options.maxRetries) {
          break;
        }

        this.logger.warn(
          `LEVE | Intento ${attempt + 1}/${options.maxRetries + 1} contra "${url.hostname}" fallido (${classifyNavigationError(error)}); se reintenta en ${options.retryDelayMs} ms.`,
        );

        await this.sleep(options.retryDelayMs);
      }
    }

    return {
      success: false,
      code: classifyNavigationError(lastError),
      message: `No se pudo cargar "${href}" tras ${options.maxRetries + 1} intento(s): ${messageOf(lastError)}`,
      attempts: options.maxRetries + 1,
      ...stackTraceOf(lastError),
    };
  }

  /**
   * Aisla el articulo del documento descargado.
   *
   * El caso "la pagina cargo pero no hay articulo" tiene codigo PROPIO y no cae
   * en el cajon de `ERR_EXTERNAL_SERVER_UNREACHABLE`: son diagnosticos opuestos
   * —el servidor respondio perfectamente— y confundirlos manda al operador a
   * revisar la red cuando lo que pasa es que la URL apunta a un indice, a un PDF
   * o a una pagina que pinta su contenido con JavaScript que no llego a tiempo.
   */
  private buildOutcome(
    html: string,
    finalUrl: string,
    attempts: number,
    hooks: ArticleExtractionHooks,
  ): ScrapeOutcome {
    // Los avisos se encadenan: SIEMPRE van al `.log` del servidor, y ademas al
    // hook que pase el llamante. Es lo que permite que el banco de pruebas del
    // asistente muestre al operador lo que en la ejecucion real solo queda en el
    // archivo, sin que la estrategia pierda su traza.
    const article = extractArticle(html, finalUrl, {
      onReadabilityFailure: (reason) => {
        this.logger.warn(`LEVE | ${reason}`);
        hooks.onReadabilityFailure?.(reason);
      },
      onContentTooShort: (length) => {
        this.logger.warn(
          `LEVE | El contenido aislado de "${finalUrl}" tiene ${length} caracteres: insuficiente para tratarlo como articulo.`,
        );
        hooks.onContentTooShort?.(length);
      },
    });

    if (article === null) {
      return {
        success: false,
        code: ERR_SCRAPER_EMPTY_CONTENT,
        message: `La pagina "${finalUrl}" se cargo pero no contiene un articulo aprovechable.`,
        sourceUrl: finalUrl,
        attempts,
      };
    }

    return { success: true, sourceUrl: finalUrl, article, attempts };
  }

  /**
   * Heuristica de bloqueo, en orden de coste creciente.
   *
   * Se evalua ANTES de extraer: una pagina de login tiene texto suficiente para
   * superar el listado de `MIN_ARTICLE_LENGTH`, y sin esta comprobacion el nodo
   * publicaria "Introduzca su usuario y contrasena" como si fuera la noticia.
   */
  private async detectBlock(
    page: Page,
    status: number | null,
    finalUrl: string,
  ): Promise<string | null> {
    if (status !== null && BLOCKING_HTTP_STATUSES.has(status)) {
      return `el servidor respondio ${status}`;
    }

    // Se descarta el host para no juzgar un dominio por su nombre; solo se
    // miran la ruta y la query.
    const parsed = new URL(finalUrl);
    const path = `${parsed.pathname}${parsed.search}`;

    if (BLOCKING_URL_PATTERNS.some((pattern) => pattern.test(path))) {
      return `la navegacion acabo en "${finalUrl}", que es una pagina de acceso`;
    }

    const title = await page.title();

    if (BLOCKING_TITLE_PATTERNS.some((pattern) => pattern.test(title))) {
      return `el titulo ("${title}") es el de un intersticial anti-bot`;
    }

    // `$` y no `waitForSelector`: el muro ya esta pintado o no lo esta, y
    // esperar por el sumaria el timeout entero a CADA pagina sana.
    if ((await page.$(BLOCKING_SELECTORS)) !== null) {
      return 'la pagina contiene un formulario de acceso, un captcha o un muro de pago';
    }

    return null;
  }

  /**
   * Cierra el contexto sin dejar que un fallo al cerrar enmascare el resultado.
   *
   * Mismo criterio que las liberaciones silenciosas de `ImapTriggerStrategy`: si
   * el `finally` lanzara, sustituiria el resultado que ya se habia decidido
   * —incluido un exito— por una excepcion sobre la limpieza.
   */
  private async closeQuietly(context: BrowserContext | null): Promise<void> {
    if (context === null) {
      return;
    }

    try {
      await context.close();
    } catch (error) {
      this.logger.warn(
        `LEVE | No se pudo cerrar el contexto del navegador: ${messageOf(error)}.`,
      );
    }
  }

  /** Espera entre reintentos. Metodo propio para poder neutralizarlo en pruebas. */
  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}
