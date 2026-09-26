import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { firstValueFrom } from 'rxjs';

import type { NodeErrorDetail } from '@core/fsm/types/node-strategy.types';
import type { AxiosError, AxiosRequestConfig } from 'axios';

/**
 * Codigos de fallo de ESTA capa: los que se deciden mirando una respuesta HTTP.
 *
 * Viven aqui y no en `@core/fsm/types/node-strategy.types` por la misma regla
 * que aplican las estrategias: el motor no debe conocer los codigos de nadie.
 * Lo comun es el FORMATO —`ERR_` y UPPER_SNAKE_CASE— porque estos valores se
 * escriben a mano en el `catchErrors` de un `pipeline_schema`.
 */
export const ERR_HTTP_TIMEOUT = 'ERR_HTTP_TIMEOUT';
export const ERR_HTTP_UPSTREAM_UNAVAILABLE = 'ERR_HTTP_UPSTREAM_UNAVAILABLE';
export const ERR_HTTP_CLIENT_REJECTED = 'ERR_HTTP_CLIENT_REJECTED';

/** Espera maxima por defecto de una peticion saliente: quince segundos. */
export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

/** Reintentos por defecto, adicionales al primer intento. */
export const DEFAULT_HTTP_MAX_RETRIES = 3;

/** Espera base del backoff exponencial, en milisegundos. */
export const DEFAULT_HTTP_BASE_DELAY_MS = 500;

/** Factor del backoff: cada intento espera el doble que el anterior. */
export const HTTP_BACKOFF_FACTOR = 2;

/**
 * Codigos de estado que SI merecen otro intento.
 *
 * `429` porque el proveedor esta pidiendo explicitamente que se espere, y la
 * familia `5xx` porque describe una averia del otro lado que suele ser pasajera.
 * Cualquier otro `4xx` queda fuera a proposito: un `401` o un `400` se repiten
 * identicos las veces que haga falta, y reintentarlos solo gasta tiempo —y, con
 * un proveedor de pago detras, dinero.
 */
const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([429]);

/** Opciones por peticion. Todas caen a los valores por defecto del modulo. */
export interface HttpClientOptions {
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
}

/**
 * Union discriminada: o hay respuesta, o hay un fallo listo para devolver.
 *
 * Mismo patron que `web-scraper.strategy.ts`. Este servicio NO lanza en un
 * fallo de red: si lo hiciera, `FsmEngineService.toDomainFailure` clasificaria
 * la excepcion como catastrofica y marcaria la ejecucion FALLIDO, cuando un
 * portal caido es justo lo que el operador puede reintentar con el flujo
 * PAUSADO (CU-09).
 */
export type HttpClientOutcome<T> =
  | { readonly data: T }
  | { readonly failure: NodeErrorDetail };

/** Espera pasiva entre reintentos. */
const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Cliente HTTP compartido de las peticiones SALIENTES del backend.
 *
 * Centraliza las tres cosas que todo nodo que sale a Internet necesita y que,
 * repetidas nodo a nodo, divergen: el timeout, el reintento con backoff
 * exponencial y la traduccion del error de Axios a un `NodeErrorDetail` con su
 * severidad. Es el primer consumidor de `@nestjs/axios` en el proyecto.
 *
 * TODOS los fallos que emite son `GRAVE`. No es una simplificacion: solo los
 * `GRAVE` entran en la politica de reintentos del motor
 * (`FsmEngineService.canRetry`), y cada modo de fallo de aqui —un token
 * caducado, una cuota agotada, un proveedor caido— es algo que un operador mira
 * y corrige con la ejecucion pausada. `URGENTE` queda reservado a quien pueda
 * afirmar que insistir es contraproducente; en el nodo de IA, eso es el freno de
 * emergencia.
 */
@Injectable()
export class HttpClientService {
  private readonly logger = new Logger(HttpClientService.name);

  constructor(private readonly httpService: HttpService) {}

  /**
   * Ejecuta una peticion aplicando timeout, reintentos y traduccion de errores.
   *
   * El bucle cuenta INTENTOS, no reintentos: `maxRetries: 3` produce hasta
   * cuatro llamadas. Solo se reintenta lo que `isRetryable` admite, de modo que
   * un `401` sale por la primera vuelta sin gastar las esperas.
   */
  public async request<T>(
    config: AxiosRequestConfig,
    options: HttpClientOptions = {},
  ): Promise<HttpClientOutcome<T>> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    const maxRetries = options.maxRetries ?? DEFAULT_HTTP_MAX_RETRIES;
    const baseDelayMs = options.baseDelayMs ?? DEFAULT_HTTP_BASE_DELAY_MS;

    let lastFailure: NodeErrorDetail = {
      level: 'GRAVE',
      code: ERR_HTTP_UPSTREAM_UNAVAILABLE,
      message: 'La peticion no llego a ejecutarse.',
    };

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await firstValueFrom(
          this.httpService.request<T>({ timeout: timeoutMs, ...config }),
        );

        return { data: response.data };
      } catch (error) {
        lastFailure = this.toFailure(error);

        if (!this.isRetryable(lastFailure) || attempt === maxRetries) {
          break;
        }

        const delay = baseDelayMs * HTTP_BACKOFF_FACTOR ** attempt;

        this.logger.warn(
          `${lastFailure.code} | Intento ${attempt + 1}/${maxRetries + 1} fallido contra "${config.url ?? 'sin url'}". Reintento en ${delay} ms.`,
        );

        await sleep(delay);
      }
    }

    this.logger.warn(
      `${lastFailure.code} | Peticion agotada contra "${config.url ?? 'sin url'}": ${lastFailure.message}`,
    );

    return { failure: lastFailure };
  }

  /**
   * Traduce cualquier excepcion de Axios al contrato de error de los nodos.
   *
   * Se discrimina por lo que el error PERMITE decidir, no por su clase: lo unico
   * que cambia el desenlace aguas arriba es si conviene o no volver a intentarlo,
   * y eso lo determina el codigo que se asigne aqui.
   */
  private toFailure(error: unknown): NodeErrorDetail {
    const stackTrace = error instanceof Error ? error.stack : undefined;

    if (!axios.isAxiosError(error)) {
      return {
        level: 'GRAVE',
        code: ERR_HTTP_UPSTREAM_UNAVAILABLE,
        message: this.describe(error),
        ...(stackTrace === undefined ? {} : { stackTrace }),
      };
    }

    const axiosError: AxiosError = error;

    // Timeout propio del cliente. `ERR_CANCELED` aparece cuando la peticion se
    // aborta por la senal que Axios asocia al `timeout`.
    if (
      axiosError.code === 'ECONNABORTED' ||
      axiosError.code === 'ETIMEDOUT' ||
      axiosError.code === 'ERR_CANCELED'
    ) {
      return {
        level: 'GRAVE',
        code: ERR_HTTP_TIMEOUT,
        message: `La peticion excedio el tiempo maximo de espera: ${this.describe(error)}`,
        ...(stackTrace === undefined ? {} : { stackTrace }),
      };
    }

    const status = axiosError.response?.status;

    // Sin respuesta no hay nada que clasificar por estado: es DNS, conexion
    // rechazada o red caida. Todo ello pasajero por definicion.
    if (status === undefined) {
      return {
        level: 'GRAVE',
        code: ERR_HTTP_UPSTREAM_UNAVAILABLE,
        message: `No se pudo contactar con el servicio remoto: ${this.describe(error)}`,
        ...(stackTrace === undefined ? {} : { stackTrace }),
      };
    }

    if (status >= 500 || RETRYABLE_STATUS_CODES.has(status)) {
      return {
        level: 'GRAVE',
        code: ERR_HTTP_UPSTREAM_UNAVAILABLE,
        message: `El servicio remoto respondio ${status}: ${this.describe(error)}`,
        ...(stackTrace === undefined ? {} : { stackTrace }),
      };
    }

    return {
      level: 'GRAVE',
      code: ERR_HTTP_CLIENT_REJECTED,
      message: `El servicio remoto rechazo la peticion con ${status}: ${this.describe(error)}`,
      ...(stackTrace === undefined ? {} : { stackTrace }),
    };
  }

  /**
   * Decide si el fallo admite otra vuelta.
   *
   * `ERR_HTTP_CLIENT_REJECTED` queda fuera: un `4xx` de cliente es determinista
   * y repetirlo devuelve exactamente el mismo `4xx`.
   */
  private isRetryable(failure: NodeErrorDetail): boolean {
    return failure.code !== ERR_HTTP_CLIENT_REJECTED;
  }

  /** Mensaje legible de una excepcion de tipo desconocido. */
  private describe(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
