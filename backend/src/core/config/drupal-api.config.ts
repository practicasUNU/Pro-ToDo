import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DEFAULT_HTTP_TIMEOUT_MS } from '@core/http/http-client.service';

/**
 * Credenciales y destino de la API de Drupal, declarados en el entorno.
 *
 * Existe como clase y no como tres `configService.get(...)` sueltos dentro de la
 * estrategia por el mismo motivo que `AiDefaultsConfig`: son valores de
 * INFRAESTRUCTURA, y tenerlos aqui permite que la estrategia se instancie en una
 * prueba con un doble de cuatro lineas en vez de con un `ConfigService` entero.
 *
 * NO valida en el constructor ni lanza si falta algo. Un `.env` incompleto no
 * debe impedir el arranque del contenedor —el backend sirve otros nueve nodos
 * que no hablan con Drupal—, solo la ejecucion de ESTE nodo, que es quien
 * comprueba `isUsable` y devuelve `ERR_DRUPAL_CONFIG`.
 */

/** Raiz de la API, con el sufijo `/jsonapi` ya incluido en el valor. */
export const DRUPAL_API_BASE_URL_VAR = 'DRUPAL_API_BASE_URL';

/** Token Bearer. Es el unico metodo de autenticacion aprobado (HTTP 200). */
export const DRUPAL_API_TOKEN_VAR = 'DRUPAL_API_TOKEN';

/** Espera maxima de una peticion a Drupal, en milisegundos. */
export const DRUPAL_API_TIMEOUT_MS_VAR = 'DRUPAL_API_TIMEOUT_MS';

/**
 * Raiz por defecto: el portal institucional.
 *
 * Lleva `/jsonapi` porque es lo que vale como base de TODAS las rutas del
 * modulo (`/node/page/{uuid}`, `/node/noticias`). Partirlo en host + sufijo
 * repartiria la misma decision entre el `.env` y el codigo.
 */
export const DEFAULT_DRUPAL_API_BASE_URL = 'https://www.madrimasd.org/jsonapi';

@Injectable()
export class DrupalApiConfig {
  constructor(private readonly configService: ConfigService) {}

  /** Raiz de la API sin barra final, para concatenar rutas sin duplicarla. */
  public get baseUrl(): string {
    const raw = this.configService.get<string>(DRUPAL_API_BASE_URL_VAR)?.trim();

    const resolved =
      raw === undefined || raw.length === 0 ? DEFAULT_DRUPAL_API_BASE_URL : raw;

    return resolved.replace(/\/+$/, '');
  }

  /** Token Bearer, o cadena vacia si el entorno no lo declara. */
  public get token(): string {
    return this.configService.get<string>(DRUPAL_API_TOKEN_VAR)?.trim() ?? '';
  }

  /**
   * Espera maxima por peticion.
   *
   * Un valor no numerico o no positivo cae al defecto en vez de propagarse: un
   * `timeout: NaN` deja la peticion colgada para siempre, que es peor que
   * ignorar una variable mal escrita.
   */
  public get timeoutMs(): number {
    const parsed = Number(
      this.configService.get<string>(DRUPAL_API_TIMEOUT_MS_VAR),
    );

    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_HTTP_TIMEOUT_MS;
  }

  /**
   * Hay credenciales suficientes para intentar una peticion.
   *
   * Solo mira el token: `baseUrl` siempre resuelve a algo por el defecto, y un
   * token vacio es el unico fallo que garantiza un 401 contra cualquier ruta.
   */
  public get isUsable(): boolean {
    return this.token.length > 0;
  }
}
