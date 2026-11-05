import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DEFAULT_HTTP_TIMEOUT_MS } from '@core/http/http-client.service';

/**
 * Destino y credencial de la API de Acens, declarados en el entorno.
 *
 * Existe como clase por el mismo motivo que `DrupalApiConfig`: son valores de
 * INFRAESTRUCTURA. El nodo DESTINO_ACENS solo elige la ruta relativa
 * (`endpointPath`); la raiz y la clave nunca viajan en el `pipeline_schema`, ni
 * en los checkpoints, ni al cliente (`security-and-scope.md` §0.1).
 *
 * NO valida en el constructor ni lanza si falta algo: un `.env` sin Acens no
 * debe impedir el arranque, solo la ejecucion de ESTE nodo, que comprueba
 * `isUsable` y devuelve `ERR_DESTINO_ACENS_CONFIG`.
 */

/** Raiz de la API (`https://api.acens.com/v1`). Sin ella el nodo no ejecuta. */
export const ACENS_API_BASE_URL_VAR = 'ACENS_API_BASE_URL';

/** Clave de la cuenta de servicio; viaja como `Authorization: Bearer`. */
export const ACENS_API_KEY_VAR = 'ACENS_API_KEY';

/** Espera maxima por peticion, en milisegundos. Opcional. */
export const ACENS_API_TIMEOUT_MS_VAR = 'ACENS_API_TIMEOUT_MS';

@Injectable()
export class AcensApiConfig {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Raiz de la API sin barra final, o cadena vacia si no se declara.
   *
   * No tiene defecto, a diferencia de Drupal: un envio masivo a una cuenta que
   * nadie configuro explicitamente es peor que no enviar.
   */
  public get baseUrl(): string {
    return (
      this.configService
        .get<string>(ACENS_API_BASE_URL_VAR)
        ?.trim()
        .replace(/\/+$/, '') ?? ''
    );
  }

  /** Clave de la API, o cadena vacia si el entorno no la declara. */
  public get apiKey(): string {
    return this.configService.get<string>(ACENS_API_KEY_VAR)?.trim() ?? '';
  }

  /**
   * Espera maxima por peticion. Un valor no numerico o no positivo cae al
   * defecto del cliente HTTP: un `timeout: NaN` dejaria la peticion colgada.
   */
  public get timeoutMs(): number {
    const parsed = Number(
      this.configService.get<string>(ACENS_API_TIMEOUT_MS_VAR),
    );

    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_HTTP_TIMEOUT_MS;
  }

  /** Cabecera `Authorization` ya compuesta: un solo sitio decide el esquema. */
  public get authHeader(): string {
    return `Bearer ${this.apiKey}`;
  }

  /**
   * Hay raiz https y clave para intentar una peticion.
   *
   * Se exige https porque la clave viaja en cada peticion: una raiz `http://`
   * mal copiada la mandaria en claro.
   */
  public get isUsable(): boolean {
    return /^https:\/\/\S+$/i.test(this.baseUrl) && this.apiKey.length > 0;
  }
}
