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
 * Tope de caracteres del cuerpo remoto que se copia al mensaje de error.
 *
 * El tope no es cosmetico. Ese mensaje acaba en el `.log` de disco —que rota
 * por TAMANO, de modo que un cuerpo desmesurado se llevaria por delante la
 * traza de todo lo demas— y en la columna de trazabilidad de PostgreSQL. Se
 * copia el principio porque es donde los proveedores ponen el codigo y el
 * motivo; el resto suele ser relleno.
 */
export const MAX_REMOTE_BODY_CHARS = 500;

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
  { readonly data: T } | { readonly failure: NodeErrorDetail };

/**
 * Variante de `HttpClientOutcome` que ademas expone el ESTADO HTTP crudo.
 *
 * Existe porque `toFailure` asigna sus propios codigos —todos GRAVE— y esa
 * clasificacion es correcta para un proveedor de IA pero insuficiente para un
 * destino como Drupal, que necesita distinguir un 401 de un 404: los dos salen
 * de aqui como `ERR_HTTP_CLIENT_REJECTED`, y deducir cual fue leyendo el
 * `message` seria atarse a un texto libre que puede reescribirse cualquier dia
 * sin romper ningun test. El consumidor necesita ademas el numero en si para
 * publicarlo en su payload.
 *
 * `status` es OPCIONAL solo en la rama de fallo, y su ausencia es INFORMACION:
 * significa que no hubo respuesta que clasificar —DNS, conexion rechazada,
 * timeout—, que es justo lo que distingue una averia de red de una respuesta
 * del servidor remoto.
 */
export type HttpClientStatusOutcome<T> =
  | { readonly data: T; readonly status: number }
  | { readonly failure: NodeErrorDetail; readonly status?: number };

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
    const outcome = await this.executeWithStatus<T>(config, options);

    // Se RECONSTRUYE el objeto en vez de devolver el enriquecido tal cual.
    // Devolverlo compilaria —un tipo mas ancho es asignable a uno mas estrecho,
    // y el chequeo de propiedades sobrantes solo alcanza a los literales—, pero
    // colaria `status` en runtime y rompería todo `toEqual({ data: ... })` de
    // quien ya consume este metodo. El coste es un objeto por peticion; a
    // cambio, la extension es literalmente invisible aguas abajo.
    return 'failure' in outcome
      ? { failure: outcome.failure }
      : { data: outcome.data };
  }

  /**
   * Como `request`, pero devolviendo tambien el estado HTTP de la respuesta.
   *
   * Comparte bucle, politica de reintentos y traduccion de errores con
   * `request`: las dos entran por `executeWithStatus`, de modo que no hay dos
   * politicas que puedan divergir. La diferencia es solo cuanta informacion se
   * deja ver.
   *
   * Lo consume `DrupalHttpStrategy`, que necesita el numero para publicarlo en
   * su payload y para repartir los codigos `ERR_DRUPAL_*` por familia de estado.
   */
  public async requestWithStatus<T>(
    config: AxiosRequestConfig,
    options: HttpClientOptions = {},
  ): Promise<HttpClientStatusOutcome<T>> {
    return this.executeWithStatus<T>(config, options);
  }

  /**
   * Bucle de intentos, backoff y traduccion de errores. UNICA copia.
   *
   * El bucle cuenta INTENTOS, no reintentos: `maxRetries: 3` produce hasta
   * cuatro llamadas. Solo se reintenta lo que `isRetryable` admite, de modo que
   * un `401` sale por la primera vuelta sin gastar las esperas.
   */
  private async executeWithStatus<T>(
    config: AxiosRequestConfig,
    options: HttpClientOptions,
  ): Promise<HttpClientStatusOutcome<T>> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    const maxRetries = options.maxRetries ?? DEFAULT_HTTP_MAX_RETRIES;
    const baseDelayMs = options.baseDelayMs ?? DEFAULT_HTTP_BASE_DELAY_MS;

    let lastFailure: NodeErrorDetail = {
      level: 'GRAVE',
      code: ERR_HTTP_UPSTREAM_UNAVAILABLE,
      message: 'La peticion no llego a ejecutarse.',
    };
    let lastStatus: number | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await firstValueFrom(
          this.httpService.request<T>({ timeout: timeoutMs, ...config }),
        );

        return { data: response.data, status: response.status };
      } catch (error) {
        lastFailure = this.toFailure(error);
        lastStatus = this.extractStatus(error);

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

    // Spread condicional y no `status: lastStatus`: con
    // `exactOptionalPropertyTypes` una propiedad opcional no admite `undefined`
    // explicito. Mismo patron que `toFailure` con `stackTrace`.
    return {
      failure: lastFailure,
      ...(lastStatus === undefined ? {} : { status: lastStatus }),
    };
  }

  /**
   * Estado HTTP de una excepcion, si la hubo.
   *
   * Va aparte de `toFailure` a proposito: aquella decide codigo, nivel y
   * mensaje por cinco ramas, y devolver ademas el estado obligaria a cambiar su
   * tipo de retorno y a revisar las cinco. Esto son tres lineas que no tocan
   * nada.
   */
  private extractStatus(error: unknown): number | undefined {
    return axios.isAxiosError(error) ? error.response?.status : undefined;
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
        message: `El servicio remoto respondio ${status}: ${this.describe(error)}${this.describeRemoteBody(axiosError)}`,
        ...(stackTrace === undefined ? {} : { stackTrace }),
      };
    }

    return {
      level: 'GRAVE',
      code: ERR_HTTP_CLIENT_REJECTED,
      message: `El servicio remoto rechazo la peticion con ${status}: ${this.describe(error)}${this.describeRemoteBody(axiosError)}`,
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

  /**
   * Cuerpo de la respuesta remota, listo para concatenar al mensaje.
   *
   * Existe porque sin el, el diagnostico del proveedor se perdia entero. El
   * caso que lo motiva: Google devolvia un 404 cuyo cuerpo decia «models/... is
   * not found for API version v1beta», y lo unico que llegaba al log era el
   * `Request failed with status code 404` de Axios — indistinguible de una URL
   * mal construida, y por eso hubo que auditar a mano lo que el remoto ya habia
   * explicado.
   *
   * Devuelve cadena VACIA cuando no hay nada que contar, para que el llamante
   * lo concatene sin condicionales. Un cuerpo que no se puede serializar
   * —referencias ciclicas, un `Buffer`— se omite en vez de propagar la
   * excepcion: esta funcion corre dentro de la traduccion de UN error, y
   * reventar aqui sustituiria el fallo real por otro.
   */
  private describeRemoteBody(error: AxiosError): string {
    const body = error.response?.data;

    if (body === undefined || body === null || body === '') {
      return '';
    }

    let serialized: string;

    try {
      serialized =
        typeof body === 'string' ? body : (JSON.stringify(body) ?? '');
    } catch {
      return '';
    }

    const trimmed = serialized.trim();

    if (trimmed.length === 0) {
      return '';
    }

    const clipped =
      trimmed.length > MAX_REMOTE_BODY_CHARS
        ? `${trimmed.slice(0, MAX_REMOTE_BODY_CHARS)}...[truncado]`
        : trimmed;

    return ` | Respuesta del remoto: ${clipped}`;
  }
}
