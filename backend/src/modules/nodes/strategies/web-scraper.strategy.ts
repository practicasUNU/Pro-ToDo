import { Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
// Import de VALOR: `errors.TimeoutError` se usa en un `instanceof`, que no
// sobrevive a un `import type`.
import { errors as playwrightErrors } from 'playwright';

import { MissingContextVariableException } from '@core/fsm/context/state-payload.context';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import {
  WebScraperConfigDto,
  resolveWebScraperConfig,
} from '@modules/nodes/dto/web-scraper-config.dto';
import { BrowserPoolService } from '@modules/nodes/services/browser-pool.service';
import { extractArticle } from '@modules/nodes/utils/article-extractor.util';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type {
  INodeStrategy,
  NodeErrorDetail,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';
import type { ResolvedWebScraperConfig } from '@modules/nodes/dto/web-scraper-config.dto';
import type { ValidatorOptions } from 'class-validator';
import type { BrowserContext, Page } from 'playwright';

/** Codigos de fallo del nodo. Son lo que un `catchErrors` puede mencionar. */
export const ERR_SCRAPER_CONFIG = 'ERR_SCRAPER_CONFIG';
export const ERR_SCRAPER_URL_UNRESOLVED = 'ERR_SCRAPER_URL_UNRESOLVED';
export const ERR_SCRAPER_URL_MALFORMED = 'ERR_SCRAPER_URL_MALFORMED';
export const ERR_SCRAPING_TIMEOUT_EXCEEDED = 'ERR_SCRAPING_TIMEOUT_EXCEEDED';
export const ERR_EXTERNAL_SERVER_UNREACHABLE =
  'ERR_EXTERNAL_SERVER_UNREACHABLE';
export const ERR_ACCESS_DENIED_BLOCK_DETECTED =
  'ERR_ACCESS_DENIED_BLOCK_DETECTED';
export const ERR_SCRAPER_EMPTY_CONTENT = 'ERR_SCRAPER_EMPTY_CONTENT';

/** Opciones de validacion canonicas del repositorio. */
const VALIDATION_OPTIONS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

/** Union discriminada: o hay configuracion, o hay un fallo que devolver. */
type ScraperConfigResolution =
  | { readonly config: ResolvedWebScraperConfig }
  | { readonly failure: NodeErrorDetail };

/**
 * Margen de cortesia para que el contenido diferido se pinte tras el DOM.
 *
 * Tiene su PROPIO presupuesto, separado de `timeoutMs`, porque es opcional: si
 * vence se extrae lo que ya hubiera, y nunca es causa de fallo.
 */
const NETWORK_SETTLE_TIMEOUT_MS = 3_000;

/** Esquemas navegables. Ver la guarda de `resolveTargetUrl`. */
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

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

/** Traza completa del error, si la hay, lista para fusionar en el detalle. */
const stackTraceOf = (error: unknown): { stackTrace?: string } =>
  error instanceof Error && error.stack !== undefined
    ? { stackTrace: error.stack }
    : {};

/** Mensaje legible de cualquier cosa lanzable. */
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Traduce un fallo de navegacion al codigo de error del nodo.
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
 * Nodo EXTRACTOR_WEB: navega a un articulo y devuelve su texto limpio.
 *
 * Es el consumidor natural de `parsed_email.extracted_urls`, que `PARSER_PRE_IA`
 * ya publica deduplicado y sin parametros de campana. Su salida alimenta al
 * `PROCESADOR_IA`, y de ahi que el contrato prometa TEXTO PLANO: cada etiqueta
 * que sobreviviera hasta aqui se pagaria en tokens del modelo.
 *
 * ESTA CLASE ES SOLO EL CONTRATO DEL NODO: validacion de `params`, resolucion de
 * la URL, gobierno del navegador y traduccion de fallos a `NodeResult`. El
 * aislamiento del articulo vive en `article-extractor.util`, funcion pura, que es
 * donde se concentran los casos limite y donde se prueban sin levantar Chromium.
 *
 * NODO PURO: no escribe en el contexto. Devuelve `data` y es `FsmEngineService`
 * quien la deposita en el `outputNamespace` declarado (`scraped_web`).
 *
 * TODOS los fallos son GRAVE: solo los GRAVE entran en la politica de reintentos
 * de `FsmEngineService.canRetry`, y todos los modos de fallo de este nodo —una
 * URL mal escrita, un portal caido, un muro de pago— son cosas que el operador
 * puede mirar y corregir con el flujo PAUSADO (CU-09). Un LEVE pausaria igual
 * pero le quitaria la opcion de reintentar.
 */
@Injectable()
export class WebScraperStrategy implements INodeStrategy {
  public readonly nodeType = NodeType.EXTRACTOR_WEB;

  private readonly logger = new Logger(WebScraperStrategy.name);

  constructor(private readonly browserPool: BrowserPoolService) {}

  public async execute(
    context: StatePayloadContext,
    params: Record<string, unknown>,
  ): Promise<NodeResult> {
    const resolution = await this.resolveConfig(params);

    if ('failure' in resolution) {
      return { success: false, error: resolution.failure };
    }

    const { config } = resolution;
    const target = this.resolveTargetUrl(context, config);

    if ('failure' in target) {
      return { success: false, error: target.failure };
    }

    return this.scrape(target.url, config);
  }

  /**
   * Valida `params` y aplica los valores por defecto.
   *
   * Se usa `validate` y NO `validateOrReject`: esta ultima lanza, y el motor
   * normaliza toda excepcion a URGENTE, que `canRetry` nunca reintenta.
   */
  private async resolveConfig(
    params: Record<string, unknown>,
  ): Promise<ScraperConfigResolution> {
    const dto = plainToInstance(WebScraperConfigDto, params);
    const errors = await validate(dto, VALIDATION_OPTIONS);

    if (errors.length > 0) {
      const constraints = errors.flatMap((error) =>
        Object.values(error.constraints ?? {}),
      );

      return {
        failure: {
          level: 'GRAVE',
          code: ERR_SCRAPER_CONFIG,
          message: `Configuracion invalida del nodo extractor web: ${constraints.join(' ')}`,
          missingFields: errors.map((error) => error.property),
        },
      };
    }

    return { config: resolveWebScraperConfig(dto) };
  }

  /**
   * Interpola `targetUrl` contra el contexto y valida el resultado.
   *
   * `getInterpolatedValue` LANZA si la ruta no resuelve, de modo que la
   * excepcion se captura aqui y se traduce a GRAVE: dejarla salir la
   * normalizaria el motor a URGENTE, que `canRetry` nunca reintenta y que el
   * operador no puede corregir desde el flujo PAUSADO.
   */
  private resolveTargetUrl(
    context: StatePayloadContext,
    config: ResolvedWebScraperConfig,
  ): { readonly url: URL } | { readonly failure: NodeErrorDetail } {
    let interpolated: string;

    try {
      interpolated = context.getInterpolatedValue(config.targetUrl);
    } catch (error) {
      if (error instanceof MissingContextVariableException) {
        return {
          failure: {
            level: 'GRAVE',
            code: ERR_SCRAPER_URL_UNRESOLVED,
            message: `No se pudo resolver "${config.targetUrl}" contra el contexto: ${error.message}`,
            missingFields: [error.variable],
            ...stackTraceOf(error),
          },
        };
      }

      // Imprevisto de verdad: que lo normalice el motor a URGENTE.
      throw error;
    }

    let url: URL;

    try {
      url = new URL(interpolated);
    } catch (error) {
      return {
        failure: {
          level: 'GRAVE',
          code: ERR_SCRAPER_URL_MALFORMED,
          message: `"${interpolated}" no es una URL valida.`,
          missingFields: ['targetUrl'],
          ...stackTraceOf(error),
        },
      };
    }

    // Lista blanca de esquemas y no una lista negra: `new URL` acepta tambien
    // `file:`, `data:` y `javascript:`, y navegar a un `file:` desde aqui seria
    // una lectura arbitraria del disco del servidor disparada por el contenido
    // de un correo entrante.
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
      return {
        failure: {
          level: 'GRAVE',
          code: ERR_SCRAPER_URL_MALFORMED,
          message: `El esquema "${url.protocol}" no es navegable; solo se admiten http y https.`,
          missingFields: ['targetUrl'],
        },
      };
    }

    return { url };
  }

  /**
   * Navega, comprueba que no hay muro y extrae el articulo.
   *
   * Un UNICO `BrowserContext` por invocacion, reutilizado entre reintentos: es
   * lo caro de crear, y el aislamiento que aporta es frente a OTRAS ejecuciones,
   * no frente al intento anterior de la misma. Se cierra siempre en el `finally`.
   */
  private async scrape(
    url: URL,
    config: ResolvedWebScraperConfig,
  ): Promise<NodeResult> {
    let browserContext: BrowserContext | null = null;

    try {
      browserContext = await this.browserPool.createContext();
      const page = await browserContext.newPage();

      return await this.navigateWithRetries(page, url, config);
    } catch (error) {
      // Cubre tambien `createContext()` y `newPage()`: ninguna excepcion sale de
      // `execute()`.
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: classifyNavigationError(error),
          message: `No se pudo extraer "${url.toString()}": ${messageOf(error)}`,
          ...stackTraceOf(error),
        },
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
   * MULTIPLICAN, asi que este nodo debe declararse en el esquema con
   * `retryPolicy: { maxRetries: 0 }` (ver el TSDoc de `WebScraperConfigDto`).
   */
  private async navigateWithRetries(
    page: Page,
    url: URL,
    config: ResolvedWebScraperConfig,
  ): Promise<NodeResult> {
    const href = url.toString();
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
      try {
        const response = await page.goto(href, {
          timeout: config.timeoutMs,
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
            error: {
              level: 'GRAVE',
              code: ERR_ACCESS_DENIED_BLOCK_DETECTED,
              message: `Acceso denegado en "${finalUrl}": ${blockReason}.`,
            },
          };
        }

        return this.buildResult(await page.content(), finalUrl);
      } catch (error) {
        lastError = error;

        if (attempt === config.maxRetries) {
          break;
        }

        this.logger.warn(
          `LEVE | Intento ${attempt + 1}/${config.maxRetries + 1} contra "${url.hostname}" fallido (${classifyNavigationError(error)}); se reintenta en ${config.retryDelayMs} ms.`,
        );

        await this.sleep(config.retryDelayMs);
      }
    }

    return {
      success: false,
      error: {
        level: 'GRAVE',
        code: classifyNavigationError(lastError),
        message: `No se pudo cargar "${href}" tras ${config.maxRetries + 1} intento(s): ${messageOf(lastError)}`,
        ...stackTraceOf(lastError),
      },
    };
  }

  /**
   * Aisla el articulo y compone el payload publicado.
   *
   * El caso "la pagina cargo pero no hay articulo" tiene codigo PROPIO y no cae
   * en el cajon de `ERR_EXTERNAL_SERVER_UNREACHABLE`: son diagnosticos opuestos
   * —el servidor respondio perfectamente— y confundirlos manda al operador a
   * revisar la red cuando lo que pasa es que la URL apunta a un indice, a un PDF
   * o a una pagina que pinta su contenido con JavaScript que no llego a tiempo.
   */
  private buildResult(html: string, finalUrl: string): NodeResult {
    const article = extractArticle(html, finalUrl, {
      onReadabilityFailure: (reason) => this.logger.warn(`LEVE | ${reason}`),
      onContentTooShort: (length) =>
        this.logger.warn(
          `LEVE | El contenido aislado de "${finalUrl}" tiene ${length} caracteres: insuficiente para tratarlo como articulo.`,
        ),
    });

    if (article === null) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_SCRAPER_EMPTY_CONTENT,
          message: `La pagina "${finalUrl}" se cargo pero no contiene un articulo aprovechable.`,
        },
      };
    }

    return {
      success: true,
      data: {
        source_url: finalUrl,
        article_title: article.title,
        full_article_content: article.content,
        byline: article.byline,
        scraped_at: new Date().toISOString(),
      },
    };
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
    const path = `${new URL(finalUrl).pathname}${new URL(finalUrl).search}`;

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
   * el `finally` lanzara, sustituiria el `NodeResult` que ya se habia decidido
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
