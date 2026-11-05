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
  'DRUPAL_SANDBOX_INNOBAR_UUID',
] as const;

/**
 * Variables con los UUID de las paginas del PORTAL (produccion).
 *
 * No habilitan nada: son la lista NEGRA del entorno de pruebas. Un nodo con
 * `isSandbox: true` que apunte a una de estas paginas se niega a escribir. Las
 * paginas de pruebas y las publicas comparten instalacion y credencial, asi que
 * el UUID es lo unico que las separa.
 */
export const DRUPAL_PRODUCTION_NODE_UUID_VARS = [
  'DRUPAL_PRODUCTION_ABRIR_LICITACION_UUID',
  'DRUPAL_PRODUCTION_CERRAR_LICITACION_UUID',
  'DRUPAL_PRODUCTION_VERIFICACION_TITULOS_UUID',
  'DRUPAL_PRODUCTION_INNODAYS_UUID',
  'DRUPAL_PRODUCTION_INNOBAR_UUID',
] as const;

/** Destinos rapidos del nodo Drupal; replica de `DrupalPresetKey` del cliente. */
export const DRUPAL_PRESET_KEYS = [
  'ABRIR_LICITACION',
  'CERRAR_LICITACION',
  'VERIFICACION_TITULOS',
  'INNODAYS',
  'INNOBAR',
  'NOTIWEB',
] as const;

export type DrupalPresetKey = (typeof DRUPAL_PRESET_KEYS)[number];

/** Los dos entornos del portal. */
export type DrupalEnvironment = 'SANDBOX' | 'PRODUCTION';

/** Pagina (o par de paginas) de un preset en un entorno. */
export interface DrupalPresetTarget {
  readonly targetNodeUuid: string | null;
  readonly destinationNodeUuid: string | null;
  readonly nid: number | null;
}

/** Variables de las que sale UNA fuente de paginas de un preset. */
interface PresetTargetSource {
  readonly target: string;
  readonly destination?: string;
  readonly nid: string;
}

/**
 * De que variables sale la pagina de cada preset en cada entorno.
 *
 * Tabla EXPLICITA y no una convencion de nombres, porque las variables no la
 * siguen: las de pruebas se nombran por PAGINA (`LICITACIONES`, `TITULOS`) y
 * las del portal por PRESET (`ABRIR_LICITACION`); abrir y cerrar comparten la
 * pagina de abiertas como origen, y el NID de titulos del portal se declaro
 * como `DRUPAL_PRODUCTION_TITULOS_NID`.
 *
 * Cada preset lista sus fuentes EN ORDEN y gana la primera con un UUID valido.
 * Es lo que da a Innobar el respaldo de Innodays en pruebas: si su variable no
 * esta declarada, comparte la pagina de pruebas de Innodays —UUID y NID juntos,
 * para que no se mezclen los de dos paginas—. Notiweb no tiene ninguna:
 * `CREATE_NODE` crea entidades sueltas y no apunta a pagina alguna.
 */
export const DRUPAL_PRESET_TARGET_VARS: Readonly<
  Record<
    DrupalEnvironment,
    Readonly<Record<DrupalPresetKey, readonly PresetTargetSource[]>>
  >
> = {
  SANDBOX: {
    ABRIR_LICITACION: [
      {
        target: 'DRUPAL_SANDBOX_LICITACIONES_UUID',
        nid: 'DRUPAL_SANDBOX_LICITACIONES_NID',
      },
    ],
    CERRAR_LICITACION: [
      {
        target: 'DRUPAL_SANDBOX_LICITACIONES_UUID',
        destination: 'DRUPAL_SANDBOX_LICITACIONES_CERRADAS_UUID',
        nid: 'DRUPAL_SANDBOX_LICITACIONES_NID',
      },
    ],
    VERIFICACION_TITULOS: [
      {
        target: 'DRUPAL_SANDBOX_TITULOS_UUID',
        nid: 'DRUPAL_SANDBOX_TITULOS_NID',
      },
    ],
    INNODAYS: [
      {
        target: 'DRUPAL_SANDBOX_INNODAYS_UUID',
        nid: 'DRUPAL_SANDBOX_INNODAYS_NID',
      },
    ],
    INNOBAR: [
      {
        target: 'DRUPAL_SANDBOX_INNOBAR_UUID',
        nid: 'DRUPAL_SANDBOX_INNOBAR_NID',
      },
      {
        target: 'DRUPAL_SANDBOX_INNODAYS_UUID',
        nid: 'DRUPAL_SANDBOX_INNODAYS_NID',
      },
    ],
    NOTIWEB: [],
  },
  PRODUCTION: {
    ABRIR_LICITACION: [
      {
        target: 'DRUPAL_PRODUCTION_ABRIR_LICITACION_UUID',
        nid: 'DRUPAL_PRODUCTION_ABRIR_LICITACION_NID',
      },
    ],
    CERRAR_LICITACION: [
      {
        target: 'DRUPAL_PRODUCTION_ABRIR_LICITACION_UUID',
        destination: 'DRUPAL_PRODUCTION_CERRAR_LICITACION_UUID',
        nid: 'DRUPAL_PRODUCTION_ABRIR_LICITACION_NID',
      },
    ],
    VERIFICACION_TITULOS: [
      {
        target: 'DRUPAL_PRODUCTION_VERIFICACION_TITULOS_UUID',
        nid: 'DRUPAL_PRODUCTION_TITULOS_NID',
      },
    ],
    INNODAYS: [
      {
        target: 'DRUPAL_PRODUCTION_INNODAYS_UUID',
        nid: 'DRUPAL_PRODUCTION_INNODAYS_NID',
      },
    ],
    INNOBAR: [
      {
        target: 'DRUPAL_PRODUCTION_INNOBAR_UUID',
        nid: 'DRUPAL_PRODUCTION_INNOBAR_NID',
      },
    ],
    NOTIWEB: [],
  },
};

/** UUID v4: el identificador con el que JSON:API direcciona cada entidad. */
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Pagina vacia: el preset carga, pero el operador tiene que escribirla. */
const EMPTY_PRESET_TARGET: DrupalPresetTarget = {
  targetNodeUuid: null,
  destinationNodeUuid: null,
  nid: null,
};

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

/** Sufijo del modulo JSON:API dentro de la base de la API. */
const JSONAPI_SUFFIX = '/jsonapi';

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

  /**
   * Raiz PUBLICA del portal, sin barra final: la base de la API sin `/jsonapi`.
   *
   * Es contra lo que se resuelve el alias de un nodo para dar al operador el
   * enlace que abre la pagina publicada (`https://portal/noticias/x`), no el
   * recurso JSON:API. Si la base no termina en `/jsonapi` —un proxy que la
   * monta en otra ruta— se usa su origen, que es la apuesta menos sorprendente.
   */
  public get siteRootUrl(): string {
    const base = this.baseUrl;

    if (base.toLowerCase().endsWith(JSONAPI_SUFFIX)) {
      return base.slice(0, -JSONAPI_SUFFIX.length);
    }

    try {
      return new URL(base).origin;
    } catch {
      return base;
    }
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
    return this.readUuidSet(DRUPAL_SANDBOX_NODE_UUID_VARS);
  }

  /** UUID de las paginas del portal declaradas en el entorno, en minusculas. */
  public get productionNodeUuids(): ReadonlySet<string> {
    return this.readUuidSet(DRUPAL_PRODUCTION_NODE_UUID_VARS);
  }

  /**
   * Pagina de cada preset en cada entorno, para que el cliente la rellene.
   *
   * Los UUID son identificadores PUBLICOS de nodos de Drupal, no credenciales:
   * servirlos al cliente no expone nada (`security-and-scope.md` §0.1). Un
   * valor que no sea un UUID v4 o un entero cuenta como no declarado: un UUID
   * partido en dos lineas del `.env` dejaria si no el preset apuntando a una
   * pagina que no existe, y el fallo saldria como un 404 en ejecucion.
   */
  public get presetTargets(): Readonly<
    Record<
      DrupalEnvironment,
      Readonly<Record<DrupalPresetKey, DrupalPresetTarget>>
    >
  > {
    const resolveEnvironment = (
      environment: DrupalEnvironment,
    ): Readonly<Record<DrupalPresetKey, DrupalPresetTarget>> =>
      Object.fromEntries(
        DRUPAL_PRESET_KEYS.map((key) => [
          key,
          this.resolvePresetTarget(DRUPAL_PRESET_TARGET_VARS[environment][key]),
        ]),
      ) as Record<DrupalPresetKey, DrupalPresetTarget>;

    return {
      SANDBOX: resolveEnvironment('SANDBOX'),
      PRODUCTION: resolveEnvironment('PRODUCTION'),
    };
  }

  /** Primera fuente con un UUID de pagina valido, o la pagina vacia. */
  private resolvePresetTarget(
    sources: readonly PresetTargetSource[],
  ): DrupalPresetTarget {
    for (const source of sources) {
      const targetNodeUuid = this.readUuid(source.target);

      if (targetNodeUuid !== null) {
        return {
          targetNodeUuid,
          destinationNodeUuid:
            source.destination === undefined
              ? null
              : this.readUuid(source.destination),
          nid: this.readNid(source.nid),
        };
      }
    }

    return EMPTY_PRESET_TARGET;
  }

  /** UUID v4 de una variable, en minusculas, o `null`. */
  private readUuid(variable: string): string | null {
    const value = this.configService.get<string>(variable)?.trim() ?? '';

    return UUID_V4_PATTERN.test(value) ? value.toLowerCase() : null;
  }

  /** NID entero y positivo de una variable, o `null`. */
  private readNid(variable: string): number | null {
    const value = this.configService.get<string>(variable)?.trim() ?? '';

    return /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : null;
  }

  /** Conjunto de UUID declarados en esas variables; las vacias no cuentan. */
  private readUuidSet(variables: readonly string[]): ReadonlySet<string> {
    const uuids = variables
      .map((variable) =>
        this.configService.get<string>(variable)?.trim().toLowerCase(),
      )
      .filter((uuid): uuid is string => uuid !== undefined && uuid !== '');

    return new Set(uuids);
  }
}
