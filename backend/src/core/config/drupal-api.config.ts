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

/**
 * Credencial de la cuenta de servicio.
 *
 * Bajo `BASIC` —el modo por defecto— es la CONTRASENA de la cuenta
 * `DRUPAL_API_USER`, no un token emitido: el modulo `basic_auth` de Drupal
 * autentica contra las credenciales del usuario. El nombre de la variable se
 * conserva por compatibilidad con los `.env` ya desplegados.
 */
export const DRUPAL_API_TOKEN_VAR = 'DRUPAL_API_TOKEN';

/** Cuenta de servicio con permiso de edicion. Obligatoria en modo `BASIC`. */
export const DRUPAL_API_USER_VAR = 'DRUPAL_API_USER';

/** Esquema de autenticacion: `BASIC` (por defecto) o `BEARER`. */
export const DRUPAL_AUTH_TYPE_VAR = 'DRUPAL_AUTH_TYPE';

/** Espera maxima de una peticion a Drupal, en milisegundos. */
export const DRUPAL_API_TIMEOUT_MS_VAR = 'DRUPAL_API_TIMEOUT_MS';

/**
 * Variables con los UUID de las paginas de PRUEBAS del portal.
 *
 * Son la lista blanca del banco de pruebas: un nodo DESTINO_DRUPAL lanzado
 * desde alli solo puede escribir en estas paginas. Se leen del entorno y no se
 * cablean porque otra instalacion de Drupal tendra otras paginas de pruebas.
 * Las que no esten declaradas simplemente no entran en la lista.
 */
export const DRUPAL_SANDBOX_NODE_UUID_VARS = [
  'DRUPAL_SANDBOX_LICITACIONES_UUID',
  'DRUPAL_SANDBOX_LICITACIONES_CERRADAS_UUID',
  'DRUPAL_SANDBOX_TITULOS_UUID',
  'DRUPAL_SANDBOX_INNODAYS_UUID',
] as const;

/**
 * Esquemas de autenticacion que la estrategia sabe componer.
 *
 * `BASIC` es el que acepta la instalacion de Madrid+D, que monta el modulo
 * `basic_auth` del nucleo y NO `simple_oauth`. Un `Bearer` contra ese Drupal no
 * da 401 directamente: se evalua como peticion ANONIMA, de modo que los GET de
 * contenido publico siguen respondiendo 200 y solo falla la escritura. Esa
 * asimetria es lo que hizo creer durante dos iteraciones que la credencial era
 * correcta.
 */
export type DrupalAuthType = 'BASIC' | 'BEARER';

/** Defecto deliberado: es lo que funciona contra la instalacion real. */
export const DEFAULT_DRUPAL_AUTH_TYPE: DrupalAuthType = 'BASIC';

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

  /** Credencial de la cuenta, o cadena vacia si el entorno no la declara. */
  public get token(): string {
    return this.configService.get<string>(DRUPAL_API_TOKEN_VAR)?.trim() ?? '';
  }

  /** Cuenta de servicio, o cadena vacia. Solo se consume en modo `BASIC`. */
  public get user(): string {
    return this.configService.get<string>(DRUPAL_API_USER_VAR)?.trim() ?? '';
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
   * Esquema de autenticacion declarado en el entorno.
   *
   * Cualquier valor no reconocido cae a `BASIC` en vez de lanzar: un `.env` con
   * una errata no debe tumbar el nodo, y de las dos opciones `BASIC` es la que
   * funciona contra la instalacion real. La comparacion normaliza mayusculas
   * porque `basic` y `Basic` son la misma intencion escrita a mano.
   */
  public get authType(): DrupalAuthType {
    const raw = this.configService
      .get<string>(DRUPAL_AUTH_TYPE_VAR)
      ?.trim()
      .toUpperCase();

    return raw === 'BEARER' ? 'BEARER' : DEFAULT_DRUPAL_AUTH_TYPE;
  }

  /**
   * Cabecera `Authorization` ya compuesta, lista para el cliente HTTP.
   *
   * Se expone armada y no en piezas para que exista UN solo sitio donde se
   * decide el esquema. La estrategia hace cuatro tipos de peticion y todas
   * pasan por `buildJsonApiHeaders`; repartir ahi el `if` del modo significaria
   * que un modo nuevo pudiera olvidarse de aplicarlo.
   *
   * `Buffer.from(...).toString('base64')` es el Base64 nativo de Node: no hace
   * falta dependencia, y `btoa` no acepta bytes fuera de Latin-1, lo que
   * romperia una contrasena con acentos.
   */
  public get authHeader(): string {
    if (
      this.authType === 'BASIC' &&
      this.user.length > 0 &&
      this.token.length > 0
    ) {
      const credentials = Buffer.from(`${this.user}:${this.token}`).toString(
        'base64',
      );

      return `Basic ${credentials}`;
    }

    return `Bearer ${this.token}`;
  }

  /**
   * Hay credenciales suficientes para intentar una peticion.
   *
   * `baseUrl` siempre resuelve a algo por el defecto, asi que lo unico que se
   * comprueba son las credenciales. En `BASIC` hacen falta LAS DOS: con el
   * usuario vacio la cabecera saldria como `Basic` de `:contrasena`, que Drupal
   * rechaza igual que si no hubiera nada —pero lo haria DESPUES de gastar la
   * peticion y con un `ERR_DRUPAL_AUTH` que apunta al servidor, en vez de parar
   * aqui con `ERR_DRUPAL_CONFIG`, que apunta al `.env`, que es donde esta el
   * problema de verdad.
   */
  public get isUsable(): boolean {
    if (this.token.length === 0) return false;

    return this.authType === 'BEARER' || this.user.length > 0;
  }

  /**
   * UUID de las paginas de pruebas declaradas en el entorno, en minusculas.
   *
   * Se recalcula en cada lectura, como el resto de esta clase: una pagina
   * anadida al `.env` vale tras reiniciar sin tocar codigo.
   */
  public get sandboxNodeUuids(): ReadonlySet<string> {
    const uuids = DRUPAL_SANDBOX_NODE_UUID_VARS.map((variable) =>
      this.configService.get<string>(variable)?.trim().toLowerCase(),
    ).filter((uuid): uuid is string => uuid !== undefined && uuid !== '');

    return new Set(uuids);
  }
}
