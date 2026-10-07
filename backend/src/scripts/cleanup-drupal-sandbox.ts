// Mismas dos guardas que el E2E hermano, y por el mismo motivo: van ANTES de
// los imports porque `ImapPollingService` y `CronSchedulingService` las leen en
// su `onModuleInit`, de modo que levantar el contexto con los valores del `.env`
// de desarrollo inscribiria sondeos contra buzones reales y los CRON de todos
// los flujos activos mientras dure la limpieza.
process.env.IMAP_POLLING_ENABLED = 'false';
process.env.CRON_SCHEDULING_ENABLED = 'false';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import axios from 'axios';
import * as cheerio from 'cheerio';

import { DrupalApiConfig } from '@core/config/drupal-api.config';

import { AppModule } from '../app.module';

/**
 * Purga de los bloques que las pruebas E2E dejan publicados en el sandbox.
 *
 *   npm run drupal:cleanup                                  # /prueba-verificador-titulos
 *   npm run drupal:cleanup -- /prueba-licitaciones
 *   npm run drupal:cleanup -- /prueba-licitaciones '.mi-selector'
 *
 * POR QUE EXISTE. `www.madrimasd.org` es el portal de verdad: las paginas son de
 * sandbox, pero lo que se escribe en ellas queda publicado y visible, y cada
 * corrida con `--write` anade un bloque mas. Hasta ahora habia que retirarlos a
 * mano, deuda que el propio `test-drupal-sandbox-e2e.ts` ya declaraba.
 *
 * POR QUE ES SEGURO. La purga NO adivina que es contenido de prueba: busca
 * marcadores que solo estampan los scripts E2E. La estrategia de produccion
 * (`DrupalHttpStrategy`) no escribe ningun `data-protodo-injected` ni
 * `data-test-id`, de modo que un bloque publicado por un flujo real es
 * invisible para estos selectores. Esa asimetria es la garantia entera, y
 * conviene no romperla: el dia que la produccion marcase lo que inyecta, este
 * script pasaria a borrar contenido editorial legitimo.
 *
 * ALCANCE DE «no altera el contenido editorial». Es cierto en ESTRUCTURA, no
 * byte a byte. El PATCH reescribe el `body.value` entero con la serializacion de
 * cheerio, que normaliza —`<br/>` pasa a `<br>`, `&nbsp;` a `&#xa0;`, un
 * atributo sin comillas las gana—. No lo introduce este script: es el mismo
 * viaje de ida y vuelta que `runAppendHtmlBlock` hace en cada publicacion.
 */
const logger = new Logger('DrupalSandboxCleanup');

/** Alias por defecto, que es la pagina del verificador de titulos. */
const DEFAULT_PATH_ALIAS = '/prueba-verificador-titulos';

/** Coleccion contra la que se resuelven los alias de pagina estatica. */
const DEFAULT_BUNDLE = 'node--page';

/** Formato de texto enriquecido con el que Drupal guarda estos cuerpos. */
const DEFAULT_BODY_FORMAT = 'full_html';

/** UUID v4 canonico, para distinguir un identificador de un alias de ruta. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Alias conocido -> NOMBRE de la variable que trae su UUID.
 *
 * El mapa guarda el nombre y no el valor a proposito. Leer `process.env` aqui no
 * funcionaria: quien vuelca el `.env` es el `ConfigModule` de `AppModule`, y lo
 * hace DENTRO de `createApplicationContext`, es decir despues de que estas
 * constantes de modulo ya se evaluaron. Un mapa con valores saldria siempre con
 * el respaldo y la variable no serviria para nada.
 */
const SANDBOX_UUID_VARS: Readonly<Record<string, string>> = {
  '/prueba-licitaciones': 'DRUPAL_SANDBOX_LICITACIONES_UUID',
  '/prueba-verificador-titulos': 'DRUPAL_SANDBOX_TITULOS_UUID',
};

/**
 * Respaldo cableado de los dos nodos de sandbox confirmados en produccion.
 *
 * Son identificadores PUBLICOS, no credenciales. El respaldo existe porque los
 * valores del `.env.example` son marcadores falsos (`00000000-0000-4000-...`):
 * un `.env` copiado de la plantilla daria un 404 opaco en vez de funcionar. La
 * variable sigue mandando cuando trae algo, que es lo que permite apuntar a otra
 * instalacion sin tocar este archivo.
 */
const SANDBOX_UUID_FALLBACKS: Readonly<Record<string, string>> = {
  '/prueba-licitaciones': '7f1700bf-b54b-4c12-b71a-8a71f1f0ee38',
  '/prueba-verificador-titulos': 'b17d69d8-6998-4883-b8dc-153b55dbd9c5',
};

/**
 * Selectores de purga, en orden de aplicacion.
 *
 * El orden NO es indiferente. Los dos marcadores genericos van primero y se
 * llevan el panel entero; cuando les toca el turno a los especificos, sus nodos
 * ya estan desconectados del arbol y no vuelven a contarse. Al reves, un
 * `#collapseCEU_TEST` por delante arrancaria solo el cuerpo del acordeon y
 * dejaria publicada su cabecera huerfana.
 *
 * Los dos ultimos cubren los bloques de licitacion de prueba, que se marcan por
 * expediente en vez de por atributo porque esa es la forma que ya tenian antes
 * de que existiera este script.
 */
const DEFAULT_PURGE_SELECTORS: readonly string[] = [
  '[data-protodo-injected="true"]',
  '[data-test-id="PROTODO-E2E-TITULOS"]',
  '.panel:has(#collapseCEU_TEST)',
  '#collapseCEU_TEST',
  '.licitacion-entry[data-expediente^="TEST_"]',
  '.licitacion-entry[data-expediente^="EXP-SANDBOX-"]',
];

/** Respuesta de JSON:API para una entidad suelta. */
export interface DrupalNodeResponse {
  readonly data?: {
    readonly id?: string;
    readonly attributes?: {
      readonly body?: {
        readonly value?: string;
        readonly format?: string;
      };
    };
  };
}

/** Respuesta de JSON:API para una coleccion filtrada. */
interface DrupalCollectionResponse {
  readonly data?: ReadonlyArray<{ readonly id?: string }>;
}

export interface CleanupOptions {
  /** Alias de la pagina, con o sin barra inicial. */
  readonly pathAlias: string;

  /** Atajo: si se conoce el UUID, se ahorra el GET de resolucion. */
  readonly nodeUuid?: string;

  /** Coleccion donde vive la pagina. Por defecto `node--page`. */
  readonly bundle?: string;

  /** Selector adicional, que se evalua ANTES que los de serie. */
  readonly customSelector?: string;
}

export interface CleanupResult {
  readonly purgedCount: number;
  readonly updated: boolean;
  readonly targetUuid: string;
}

/** Resultado de la poda en memoria, sin tocar la red. */
export interface PurgeOutcome {
  readonly html: string;
  readonly purgedCount: number;
}

/**
 * Quita del marcado los elementos que casen con los selectores dados.
 *
 * Se extrae del servicio a proposito: es la unica pieza de todo esto que se
 * puede verificar sin credenciales ni salida a internet, y es justo donde vive
 * el riesgo —un selector de mas no falla, borra contenido ajeno y devuelve
 * exito—. Como funcion pura entra en una prueba unitaria; dentro del metodo que
 * hace el GET y el PATCH, no.
 *
 * Las banderas de carga son las CANONICAS del proyecto: `isDocument: false`
 * carga como fragmento, sin sintetizar `<html>`/`<body>` alrededor del cuerpo, y
 * el `xml` truthy fuerza htmlparser2 sin activar el modo XML sensible a
 * mayusculas.
 */
export const purgeMarkedBlocks = (
  html: string,
  selectors: readonly string[],
): PurgeOutcome => {
  const $ = cheerio.load(html, { xml: { xmlMode: false } }, false);
  let purgedCount = 0;

  for (const selector of selectors) {
    const targets = $(selector);

    if (targets.length > 0) {
      purgedCount += targets.length;
      targets.remove();
    }
  }

  // Si no habia nada que quitar se devuelve el original SIN serializar: el
  // llamante corta ahi y no emite PATCH, de modo que una pagina ya limpia no
  // recibe la normalizacion de cheerio por el mero hecho de haberla revisado.
  return purgedCount === 0
    ? { html, purgedCount }
    : { html: $.html(), purgedCount };
};

/** Un UUID v4, en oposicion a un alias de ruta. */
export const isUuid = (value: string): boolean =>
  UUID_PATTERN.test(value.trim());

/**
 * Deja dos HTML comparables pese a la cosmetica del viaje por Drupal.
 *
 * Unifica las TRES formas del espacio duro, que es la trampa de este caso:
 * cheerio serializa a `&#xa0;` y no a `&nbsp;`, de modo que normalizar solo la
 * entidad con nombre deja la diferencia intacta.
 */
export const normalizeHtmlForComparison = (raw: string): string =>
  raw
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(?:xa0|160);/gi, ' ')
    .replace(/\u00a0/g, ' ')
    // El espacio ENTRE etiquetas se borra, no se colapsa: una reindentacion de
    // Drupal mete saltos y sangrias ahi, y dejarlos reducidos a un espacio
    // seguiria marcando como distinto un cuerpo identicamente estructurado.
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Texto plano del fragmento, colapsado.
 *
 * Es la medida que distingue «Drupal reescribio el formato» de «falta
 * contenido»: la cosmetica no cambia lo que se lee, un borrado si.
 */
export const textContentOf = (html: string): string =>
  cheerio
    .load(html, { xml: { xmlMode: false } }, false)
    .root()
    .text()
    .replace(/\s+/g, ' ')
    .trim();

/** `node--page` -> `node/page`. */
const toEntityPath = (bundle: string): string => bundle.replace('--', '/');

/** Alias normalizado con barra inicial, que es como lo guarda Drupal. */
const toCanonicalAlias = (pathAlias: string): string =>
  pathAlias.startsWith('/') ? pathAlias : `/${pathAlias}`;

export class DrupalSandboxCleanupService {
  /**
   * Recibe el config YA RESUELTO en vez de leer el entorno por su cuenta.
   *
   * Las credenciales viven en `backend/.env` y las vuelca `ConfigModule`, no
   * `dotenv`: una clase que leyera `process.env` en su constructor veria todo
   * vacio si alguien la instancia antes del bootstrap. Ademas la cabecera Basic
   * la compone un unico sitio en todo el proyecto, el getter `authHeader`, y
   * duplicarla aqui es exactamente como se cuela un `Bearer` contra una
   * instalacion que monta `basic_auth` —que no devuelve 401: responde 200 como
   * anonimo y no escribe—.
   */
  constructor(private readonly drupalApiConfig: DrupalApiConfig) {}

  private get headers(): Record<string, string> {
    return {
      Authorization: this.drupalApiConfig.authHeader,
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
    };
  }

  /**
   * Resuelve el UUID de una pagina a partir de su alias de ruta.
   *
   * ULTIMO RECURSO, y no la via normal. Filtrar por `path.alias` es fragil en
   * esta instalacion —`path` es un campo calculado y el Entity Query devuelve
   * 500—, asi que quien llama deberia traer el UUID resuelto. Se conserva para
   * un alias que no este en los mapas conocidos.
   *
   * Un UUID pasado como alias se devuelve tal cual, sin tocar la red: es lo que
   * permite `npm run drupal:cleanup -- <uuid>` cuando la consulta falla.
   */
  public async resolveNodeUuidByAlias(
    pathAlias: string,
    bundle: string = DEFAULT_BUNDLE,
  ): Promise<string> {
    if (isUuid(pathAlias)) {
      return pathAlias.trim();
    }

    const alias = toCanonicalAlias(pathAlias);
    const url =
      `${this.drupalApiConfig.baseUrl}/${toEntityPath(bundle)}` +
      `?filter[path.alias]=${encodeURIComponent(alias)}`;

    let data: DrupalCollectionResponse;

    try {
      ({ data } = await axios.get<DrupalCollectionResponse>(url, {
        headers: this.headers,
        timeout: this.drupalApiConfig.timeoutMs,
      }));
    } catch (error) {
      // El 500 crudo de axios no dice nada util aqui. El diagnostico es
      // conocido y la salida tambien, asi que se cuentan las dos.
      const status = axios.isAxiosError(error)
        ? (error.response?.status ?? 'sin respuesta')
        : 'desconocido';

      throw new Error(
        `Drupal respondio ${status} al filtrar "${bundle}" por path.alias="${alias}". ` +
          'Esa consulta no es fiable en esta instalacion: `path` es un campo calculado. ' +
          'Pasa el UUID directamente como argumento, o declara el alias en SANDBOX_UUID_VARS.',
      );
    }

    const uuid = data.data?.[0]?.id;

    if (uuid === undefined) {
      throw new Error(
        `No se encontro ningun nodo de "${bundle}" con el alias "${alias}". ` +
          'Comprueba el alias y la coleccion: una pagina de otro bundle no aparece en este filtro.',
      );
    }

    return uuid;
  }

  /**
   * Retira los bloques de prueba de una pagina y persiste el resultado.
   *
   * Idempotente por construccion: sin coincidencias no emite PATCH y devuelve
   * `updated: false`. Reaplicarlo sobre una pagina ya limpia no escribe nada.
   */
  public async purgeInjectedBlocks(
    options: CleanupOptions,
  ): Promise<CleanupResult> {
    const bundle = options.bundle ?? DEFAULT_BUNDLE;
    const nodeUuid =
      options.nodeUuid ??
      (await this.resolveNodeUuidByAlias(options.pathAlias, bundle));
    const url = `${this.drupalApiConfig.baseUrl}/${toEntityPath(bundle)}/${nodeUuid}`;

    const { data } = await axios.get<DrupalNodeResponse>(url, {
      headers: this.headers,
      timeout: this.drupalApiConfig.timeoutMs,
    });

    const body = data.data?.attributes?.body;

    if (body?.value === undefined || body.value.length === 0) {
      return { purgedCount: 0, updated: false, targetUuid: nodeUuid };
    }

    const selectors =
      options.customSelector === undefined
        ? DEFAULT_PURGE_SELECTORS
        : [options.customSelector, ...DEFAULT_PURGE_SELECTORS];

    const { html, purgedCount } = purgeMarkedBlocks(body.value, selectors);

    if (purgedCount === 0) {
      return { purgedCount: 0, updated: false, targetUuid: nodeUuid };
    }

    await axios.patch(
      url,
      {
        data: {
          type: bundle,
          // `id` es OBLIGATORIO en un PATCH de JSON:API y debe coincidir con el
          // UUID de la URL; omitirlo devuelve un 422 cuyo cuerpo no deja claro
          // que es eso lo que falta.
          id: nodeUuid,
          attributes: {
            body: { value: html, format: body.format ?? DEFAULT_BODY_FORMAT },
          },
        },
      },
      { headers: this.headers, timeout: this.drupalApiConfig.timeoutMs },
    );

    return { purgedCount, updated: true, targetUuid: nodeUuid };
  }
}

/**
 * Entrada CLI.
 *
 * Va bajo `require.main === module` porque este archivo tambien se IMPORTA
 * desde `test-titulos-e2e.ts`: sin la guarda, pedirle el servicio dispararia
 * una limpieza completa como efecto secundario del import.
 */
/**
 * UUID de un alias conocido, o `null` si hay que resolverlo por la via larga.
 *
 * Precedencia: un UUID pasado a pelo manda sobre todo; despues la variable de
 * entorno, que es lo que permite apuntar a otra instalacion; y por ultimo el
 * respaldo cableado, para que la corrida tipica no exija configuracion.
 */
const resolveKnownUuid = (
  pathAlias: string,
  configService: ConfigService,
): string | null => {
  if (isUuid(pathAlias)) {
    return pathAlias.trim();
  }

  const alias = toCanonicalAlias(pathAlias);
  const varName = SANDBOX_UUID_VARS[alias];

  if (varName === undefined) {
    return null;
  }

  const fromEnv = configService.get<string>(varName)?.trim();

  return fromEnv !== undefined && fromEnv.length > 0
    ? fromEnv
    : (SANDBOX_UUID_FALLBACKS[alias] ?? null);
};

const main = async (): Promise<void> => {
  const pathAlias = process.argv[2] ?? DEFAULT_PATH_ALIAS;
  const customSelector = process.argv[3];

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    // `strict: false` porque `DrupalApiConfig` es provider de `NodesModule` y no
    // del scope raiz; sin ello `app.get` no lo encuentra.
    const drupalApiConfig = app.get(DrupalApiConfig, { strict: false });

    if (!drupalApiConfig.isUsable) {
      throw new Error(
        'Credenciales de Drupal incompletas. Bajo BASIC hacen falta DRUPAL_API_USER y ' +
          'DRUPAL_API_TOKEN en backend/.env.',
      );
    }

    const service = new DrupalSandboxCleanupService(drupalApiConfig);

    // Resolucion AQUI y no dentro del servicio: `ConfigService` solo tiene los
    // valores del `.env` una vez levantado el contexto, y es el unico momento en
    // que se pueden leer. Con los dos alias conocidos la consulta por
    // `path.alias` —la que devuelve 500— no llega a emitirse.
    const resolvedUuid = resolveKnownUuid(pathAlias, app.get(ConfigService));

    if (resolvedUuid !== null) {
      logger.log(`Alias conocido: ${pathAlias} | uuid=${resolvedUuid}`);
    }

    const result = await service.purgeInjectedBlocks({
      pathAlias,
      ...(resolvedUuid === null ? {} : { nodeUuid: resolvedUuid }),
      ...(customSelector === undefined ? {} : { customSelector }),
    });

    logger.log(
      `[DRUPAL_CLEANUP_SUCCESS] Purgados: ${result.purgedCount} bloque(s) | ` +
        `Actualizado: ${result.updated} | UUID: ${result.targetUuid}`,
    );
  } finally {
    // Sin esto el proceso queda colgado del pool de conexiones de TypeORM.
    await app.close();
  }
};

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error(
      `[DRUPAL_CLEANUP_ERROR] ${error instanceof Error ? error.message : 'Error desconocido'}`,
      error instanceof Error ? error.stack : undefined,
    );
    // `exitCode` y no `process.exit()`: este ultimo cortaria el `await
    // app.close()` del `finally` a medias.
    process.exitCode = 1;
  });
}
