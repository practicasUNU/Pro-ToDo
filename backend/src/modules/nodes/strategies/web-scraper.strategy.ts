import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  MissingContextVariableException,
  extractNamespaceRoots,
} from '@core/fsm/context/state-payload.context';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import {
  WebScraperConfigDto,
  resolveWebScraperConfig,
} from '@modules/nodes/dto/web-scraper-config.dto';
import { WebScraperRunner } from '@modules/nodes/services/web-scraper.runner';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type {
  INodeStrategy,
  NodeErrorDetail,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';
import type { ResolvedWebScraperConfig } from '@modules/nodes/dto/web-scraper-config.dto';
import type { ValidatorOptions } from 'class-validator';

/**
 * Codigos de fallo propios de ESTA capa: los que se deciden antes de navegar.
 *
 * Los de la navegacion y la extraccion viven en `WebScraperRunner`, que es quien
 * los produce, y se reexportan aqui abajo para que un `catchErrors` pueda
 * mencionarlos todos sin saber de que archivo sale cada uno.
 */
export const ERR_SCRAPER_CONFIG = 'ERR_SCRAPER_CONFIG';
export const ERR_SCRAPER_URL_UNRESOLVED = 'ERR_SCRAPER_URL_UNRESOLVED';
export const ERR_SCRAPER_URL_MALFORMED = 'ERR_SCRAPER_URL_MALFORMED';

export {
  ERR_ACCESS_DENIED_BLOCK_DETECTED,
  ERR_EXTERNAL_SERVER_UNREACHABLE,
  ERR_SCRAPER_EMPTY_CONTENT,
  ERR_SCRAPING_TIMEOUT_EXCEEDED,
  classifyNavigationError,
} from '@modules/nodes/services/web-scraper.runner';

/** Opciones de validacion canonicas del repositorio. */
const VALIDATION_OPTIONS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

/** Union discriminada: o hay configuracion, o hay un fallo que devolver. */
type ScraperConfigResolution =
  | { readonly config: ResolvedWebScraperConfig }
  | { readonly failure: NodeErrorDetail };

/** Esquemas navegables. Ver la guarda de `resolveTargetUrl`. */
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/** Traza completa del error, si la hay, lista para fusionar en el detalle. */
const stackTraceOf = (error: unknown): { stackTrace?: string } =>
  error instanceof Error && error.stack !== undefined
    ? { stackTrace: error.stack }
    : {};

/**
 * Nodo EXTRACTOR_WEB: navega a un articulo y devuelve su texto limpio.
 *
 * Es el consumidor natural de `parsed_email.extracted_urls`, que `PARSER_PRE_IA`
 * ya publica deduplicado y sin parametros de campana. Su salida alimenta al
 * `PROCESADOR_IA`, y de ahi que el contrato prometa TEXTO PLANO: cada etiqueta
 * que sobreviviera hasta aqui se pagaria en tokens del modelo.
 *
 * ESTA CLASE ES SOLO EL CONTRATO DEL NODO: validacion de `params`, resolucion de
 * la URL contra el contexto y traduccion del desenlace a `NodeResult`. La
 * navegacion, la deteccion de bloqueo y la extraccion viven en
 * `WebScraperRunner`, que el banco de pruebas del asistente comparte: si el
 * asistente navegase por su cuenta, el operador probaria una cosa y el flujo
 * haria otra, y la discrepancia apareceria justo en el caso que mas importa —el
 * portal que bloquea—, que es el que nadie puede reproducir a mano.
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

  constructor(private readonly runner: WebScraperRunner) {}

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

    // Se pasan SOLO los tres campos de navegacion y no la config entera: el
    // `targetUrl` ya viene resuelto dentro de `target.url`, y colarlo ademas en
    // las opciones dejaria dos copias de la misma URL —una interpolada y otra
    // sin interpolar— viajando juntas.
    const outcome = await this.runner.run(target.url, {
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      retryDelayMs: config.retryDelayMs,
    });

    if (!outcome.success) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: outcome.code,
          message: outcome.message,
          ...(outcome.stackTrace === undefined
            ? {}
            : { stackTrace: outcome.stackTrace }),
        },
      };
    }

    return {
      success: true,
      data: {
        source_url: outcome.sourceUrl,
        article_title: outcome.article.title,
        full_article_content: outcome.article.content,
        byline: outcome.article.byline,
        scraped_at: new Date().toISOString(),
      },
    };
  }

  /**
   * Namespaces que la plantilla de `targetUrl` necesita para resolverse.
   *
   * Se derivan leyendo la plantilla con el MISMO extractor que alimenta la
   * interpolacion real, de modo que lo que aqui se exige y lo que alli se
   * resuelve no puedan discrepar.
   *
   * Devuelve un arreglo VACIO cuando `targetUrl` es una URL literal —el caso del
   * flujo que vigila siempre la misma portada—: ese nodo no depende de nada
   * aguas arriba y exigirle un namespace lo haria inejecutable.
   */
  public getRequiredNamespaces(
    params: Record<string, unknown>,
  ): readonly string[] {
    return typeof params.targetUrl === 'string'
      ? extractNamespaceRoots(params.targetUrl)
      : [];
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
}
