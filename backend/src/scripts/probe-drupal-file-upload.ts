// Mismas dos guardas que `test-drupal-sandbox-e2e.ts`, y por el mismo motivo:
// `ImapPollingService` y `CronSchedulingService` leen estas variables en su
// `onModuleInit`, de modo que con los valores del `.env` de desarrollo levantar
// el contexto inscribiria sondeos contra buzones reales y los CRON de los
// flujos activos, que seguirian corriendo mientras dure este diagnostico.
//
// Va antes de los imports porque un import con efectos secundarios podria
// adelantarse a cualquier linea de `main()`.
process.env.IMAP_POLLING_ENABLED = 'false';
process.env.CRON_SCHEDULING_ENABLED = 'false';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import axios from 'axios';

import {
  DRUPAL_API_USER_VAR,
  DRUPAL_AUTH_TYPE_VAR,
  DrupalApiConfig,
} from '@core/config/drupal-api.config';
import { COMMON_FILE_FIELD_CANDIDATES } from '@modules/nodes/strategies/drupal-http.strategy';

import { AppModule } from '../app.module';

import type { AxiosResponse } from 'axios';

/**
 * Sonda de DIAGNOSTICO de la subida binaria a Drupal (JSON:API).
 *
 *   npm run probe:drupal:upload             # solo lectura: inventario de campos
 *   npm run probe:drupal:upload -- --write  # ademas intenta subir el fichero sonda
 *
 * ## Que problema responde
 *
 * `DrupalHttpStrategy.resolveTargetFileField` recorre `COMMON_FILE_FIELD_CANDIDATES`
 * contra las `relationships` del nodo y, al no encontrar ninguna, avisa con
 * `DRUPAL_NO_FILE_RELATIONSHIP` y abandona la subida. Ese aviso dice que no hay
 * campo compatible, pero NO dice que campos hay, ni si el 403/404/422 vendria del
 * campo o de los permisos de la cuenta de servicio. Esta sonda contesta las dos
 * preguntas por separado:
 *
 *   1. Inventario real de `relationships` y `attributes` del nodo anfitrion.
 *   2. Respuesta EXACTA de cada endpoint de subida candidato ante 10 bytes.
 *
 * Con eso se decide si hay que crear el campo en el CMS, ampliar los permisos de
 * la cuenta, o cambiar de endpoint.
 *
 * ## Por que la subida NO es el comportamiento por defecto
 *
 * `www.madrimasd.org` es el portal de produccion. Un POST que acierte deja una
 * entidad `file--file` permanente colgando del nodo, y cada corrida con `--write`
 * anade una mas: se acumulan y hay que retirarlas a mano. La lectura, que es la
 * mitad del diagnostico, no tiene ese coste y por eso corre siempre.
 *
 * ## Alcance
 *
 * Autocontenido: NO toca la FSM, ni el registro de estrategias, ni la tabla de
 * transiciones. Levanta el contexto de Nest unicamente para resolver
 * `DrupalApiConfig` y `ConfigService` —la misma fuente de credenciales que leera
 * la estrategia en produccion— y compone las peticiones a mano con axios.
 *
 * ## Efecto secundario que no se puede desactivar
 *
 * `FsmModule.onModuleInit` pasa INCONDICIONALMENTE toda ejecucion `EN_PROCESO` a
 * `PAUSADO` al arrancar cualquier contexto de Nest. No ejecutar con flujos en
 * vuelo.
 */
const logger = new Logger('DrupalFileUploadProbe');

/** Bandera que habilita los POST reales de la sonda. */
const WRITE_FLAG = '--write';

/** Sufijo obligatorio de la raiz de la API; ver la guarda de `assertPreflight`. */
const JSONAPI_SUFFIX = '/jsonapi';

/**
 * Nodo anfitrion por defecto: la pagina de pruebas de licitaciones.
 *
 * Se puede sobreescribir por entorno para sondear otro nodo sin tocar el codigo;
 * el literal existe para que la corrida tipica no exija configuracion previa.
 */
const PROBE_UUID_VAR = 'DRUPAL_SANDBOX_LICITACIONES_UUID';
const DEFAULT_PROBE_UUID = '7f1700bf-b54b-4c12-b71a-8a71f1f0ee38';

/** Bundle del nodo anfitrion, en la notacion de JSON:API. */
const PROBE_BUNDLE = 'node--page';

/**
 * Candidatos de campo de fichero: LA MISMA lista que prueba la estrategia.
 *
 * Se importa en vez de replicarse. Lo que esta sonda tiene que ejercitar es
 * exactamente lo que `DrupalHttpStrategy.resolveTargetFileField` probara en
 * produccion, y una copia deja de describir al nodo real en cuanto una de las
 * dos cambia — que es justo lo que ocurrio al anadir `field_fichero_adjunto`.
 */
const FILE_FIELD_CANDIDATES = COMMON_FILE_FIELD_CANDIDATES;

/** Nombre del fichero sonda. Identificable a simple vista en el CMS. */
const PROBE_FILENAME = 'probe-test.txt';

/** Carga util de la sonda: 10 bytes exactos, como pide el diagnostico. */
const PROBE_PAYLOAD = Buffer.from('PROBE-1234', 'utf8');

/** Recorte del payload de error que se vuelca al informe, en caracteres. */
const ERROR_PAYLOAD_MAX_CHARS = 2000;

/**
 * Respuesta de JSON:API recortada a lo que lee esta sonda.
 *
 * Se tipa en vez de usar `any` para que el acceso a `uri.url` no dispare
 * `no-unsafe-member-access`, y para que un cambio de forma en la respuesta salga
 * al compilar y no como `undefined` silencioso.
 */
interface DrupalEntityResponse {
  data?: {
    id?: string;
    type?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, unknown>;
  };
}

/** Un endpoint candidato de subida, con su razon de ser en el informe. */
interface UploadCandidate {
  readonly label: string;
  readonly url: string;
  readonly rationale: string;
}

/** Resultado de sondear un endpoint: siempre hay veredicto, nunca excepcion. */
interface ProbeOutcome {
  readonly label: string;
  readonly url: string;
  readonly status: number | 'SIN_RESPUESTA';
  readonly uploadedUrl: string | null;
  readonly detail: string;
}

/**
 * Comprueba el entorno ANTES de disparar nada.
 *
 * Corre DESPUES del bootstrap y lee por `DrupalApiConfig`, no por `process.env`:
 * quien vuelca el `.env` sobre el entorno es el `ConfigModule.forRoot()` de
 * `AppModule`, asi que una guarda anterior veria todas las variables vacias y
 * aprobaria cualquier configuracion. Mirar la misma fuente que mirara la
 * estrategia es ademas lo unico que hace el diagnostico representativo.
 */
const assertPreflight = (
  drupalApiConfig: DrupalApiConfig,
  configService: ConfigService,
): string => {
  if (drupalApiConfig.token === '') {
    throw new Error(
      'DRUPAL_API_TOKEN no esta definida en backend/.env: sin ella toda peticion a Drupal es un 401 y la sonda no distingue "campo inexistente" de "sin credenciales".',
    );
  }

  // La autenticacion basica exige usuario Y contrasena. Se comprueba aparte del
  // token porque el sintoma de olvidar el usuario es enganoso: Drupal evalua la
  // peticion como ANONIMA, de modo que el GET de inventario seguiria devolviendo
  // 200 y solo reventaria la subida —justo el falso positivo que esta sonda
  // existe para descartar—.
  if (drupalApiConfig.authType === 'BASIC' && drupalApiConfig.user === '') {
    throw new Error(
      `${DRUPAL_AUTH_TYPE_VAR} vale BASIC pero ${DRUPAL_API_USER_VAR} esta vacia en backend/.env. ` +
        'Declara la cuenta de servicio con permiso de edicion, o cambia a BEARER si esta instalacion usa OAuth.',
    );
  }

  if (!drupalApiConfig.baseUrl.endsWith(JSONAPI_SUFFIX)) {
    throw new Error(
      `DRUPAL_API_BASE_URL vale "${drupalApiConfig.baseUrl}" y debe terminar en "${JSONAPI_SUFFIX}": ` +
        'una raiz sin sufijo compone rutas de front-end, Drupal responde HTML y el fallo aparece como error de parseo sin pista de su origen. ' +
        `Corrigelo en backend/.env a "${drupalApiConfig.baseUrl}${JSONAPI_SUFFIX}".`,
    );
  }

  return (
    configService.get<string>(PROBE_UUID_VAR)?.trim() ?? DEFAULT_PROBE_UUID
  );
};

/** `node--page` -> `node/page`. Misma conversion que `resolveEntityPath`. */
const toEntityPath = (bundle: string): string => bundle.replace('--', '/');

/** Cabeceras del dialecto JSON:API con la credencial del entorno. */
const buildJsonApiHeaders = (
  drupalApiConfig: DrupalApiConfig,
): Record<string, string> => ({
  Authorization: drupalApiConfig.authHeader,
  Accept: 'application/vnd.api+json',
  'Content-Type': 'application/vnd.api+json',
});

/**
 * Vuelca un payload desconocido a texto legible, acotado.
 *
 * Drupal devuelve el detalle del fallo en `errors[].detail`, pero un 403 de
 * servidor intermedio puede devolver HTML entero: sin el recorte el informe se
 * vuelve ilegible justo en el caso que mas interesa leer.
 */
const describePayload = (payload: unknown): string => {
  if (payload === undefined || payload === null) return '(cuerpo vacio)';

  const rendered =
    typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);

  return rendered.length > ERROR_PAYLOAD_MAX_CHARS
    ? `${rendered.slice(0, ERROR_PAYLOAD_MAX_CHARS)}\n... (recortado)`
    : rendered;
};

/**
 * Lee la URL publica del fichero recien creado.
 *
 * `data.attributes.uri.url` es el contrato que consume
 * `DrupalHttpStrategy.readUploadedUrl`; se lee EXACTAMENTE igual aqui para que
 * un acierto de la sonda signifique que la estrategia tambien acertara. El
 * respaldo en `attributes.url` existe porque algunas instalaciones lo publican
 * ademas en plano, y verlo relleno con `uri.url` vacio es por si mismo un dato
 * del diagnostico.
 */
const readUploadedUrl = (payload: DrupalEntityResponse): string | null => {
  const attributes = payload.data?.attributes ?? {};
  const uri = attributes.uri as Record<string, unknown> | undefined;

  if (typeof uri?.url === 'string' && uri.url.length > 0) return uri.url;
  if (typeof attributes.url === 'string' && attributes.url.length > 0) {
    return attributes.url;
  }

  return null;
};

/**
 * Descarga el nodo anfitrion y publica su inventario de campos.
 *
 * Es la mitad del diagnostico que SIEMPRE corre: sin saber que relaciones
 * declara el bundle, un 404 de subida no se puede atribuir ni al campo ni a la
 * ruta.
 */
const inspectHostNode = async (
  drupalApiConfig: DrupalApiConfig,
  uuid: string,
): Promise<string[]> => {
  const url = `${drupalApiConfig.baseUrl}/${toEntityPath(PROBE_BUNDLE)}/${uuid}`;

  logger.log(`-> GET ${url}`);

  const response = await axios.get<DrupalEntityResponse>(url, {
    headers: {
      Authorization: drupalApiConfig.authHeader,
      Accept: 'application/vnd.api+json',
    },
    timeout: drupalApiConfig.timeoutMs,
    // Sin esto un 403 lanza y el script muere sin imprimir el cuerpo, que es
    // precisamente el dato que se viene a buscar.
    validateStatus: () => true,
  });

  if (response.status !== 200) {
    logger.error(
      `El nodo anfitrion no se pudo leer (HTTP ${response.status}). Cuerpo:`,
    );
    console.log(describePayload(response.data));

    throw new Error(
      'Sin inventario de campos no hay diagnostico: revisa el UUID, el bundle y los permisos de lectura de la cuenta.',
    );
  }

  const relationships = response.data.data?.relationships ?? {};
  const attributes = response.data.data?.attributes ?? {};
  const relationshipNames = Object.keys(relationships);

  logger.log(
    `Nodo "${response.data.data?.type ?? PROBE_BUNDLE}" leido · ${relationshipNames.length} relaciones · ${Object.keys(attributes).length} atributos.`,
  );

  console.log('\n----- relationships declaradas por el bundle -----');
  console.table(
    relationshipNames.map((name) => {
      const relation = relationships[name] as
        { data?: unknown; links?: Record<string, unknown> } | undefined;
      const target = relation?.data;

      return {
        campo: name,
        // Una relacion VACIA sigue existiendo en el bundle y sigue siendo
        // destino valido de una subida: distinguir "no declarado" de "declarado
        // y sin valor" es justo lo que `DRUPAL_NO_FILE_RELATIONSHIP` no dice.
        cardinalidad: Array.isArray(target)
          ? `lista(${target.length})`
          : target === null || target === undefined
            ? 'vacia'
            : 'unica',
        candidato_fichero: FILE_FIELD_CANDIDATES.includes(
          name as (typeof FILE_FIELD_CANDIDATES)[number],
        )
          ? 'SI'
          : '',
      };
    }),
  );

  console.log('\n----- attributes declarados por el bundle -----');
  console.log(Object.keys(attributes).sort().join(', '));

  const matched = FILE_FIELD_CANDIDATES.filter(
    (candidate) => candidate in relationships,
  );

  if (matched.length === 0) {
    logger.warn(
      `DRUPAL_NO_FILE_RELATIONSHIP reproducido: ninguno de los candidatos (${FILE_FIELD_CANDIDATES.join(', ')}) aparece en las relaciones del nodo.`,
    );
  } else {
    logger.log(`Candidatos presentes en el bundle: ${matched.join(', ')}.`);
  }

  return relationshipNames;
};

/**
 * Compone la bateria de endpoints a sondear.
 *
 * El orden no es decorativo: va de lo mas especifico a lo mas generico, de modo
 * que el primer acierto es tambien la ruta mas directa que la estrategia deberia
 * usar. Las relaciones REALES del nodo van primero porque son las unicas cuya
 * existencia esta confirmada; los candidatos del catalogo despues, para capturar
 * el campo que exista en el bundle pero que JSON:API no liste por permisos; y
 * `/file/file` al final, que es la creacion generica de entidad fichero sin
 * anfitrion.
 */
const buildUploadCandidates = (
  drupalApiConfig: DrupalApiConfig,
  uuid: string,
  relationshipNames: readonly string[],
): UploadCandidate[] => {
  const entityPath = toEntityPath(PROBE_BUNDLE);
  const { baseUrl } = drupalApiConfig;
  // Raiz del sitio: el endpoint del modulo REST `file.upload` NO cuelga de
  // `/jsonapi`, asi que hay que retirar el sufijo en lugar de concatenar.
  const siteRoot = baseUrl.slice(0, -JSONAPI_SUFFIX.length);

  const fieldNames = [
    ...new Set<string>([...relationshipNames, ...FILE_FIELD_CANDIDATES]),
  ];

  const jsonApiFieldEndpoints = fieldNames.map<UploadCandidate>((field) => ({
    label: `jsonapi:${field}`,
    url: `${baseUrl}/${entityPath}/${uuid}/${field}`,
    rationale: relationshipNames.includes(field)
      ? 'Relacion declarada por el nodo'
      : 'Candidato del catalogo, no declarado en las relaciones',
  }));

  const restFieldEndpoints = FILE_FIELD_CANDIDATES.map<UploadCandidate>(
    (field) => ({
      label: `rest:${field}`,
      url: `${siteRoot}/file/upload/node/page/${field}?_format=json`,
      rationale: 'Endpoint del modulo REST file.upload (fuera de /jsonapi)',
    }),
  );

  return [
    ...jsonApiFieldEndpoints,
    ...restFieldEndpoints,
    {
      label: 'jsonapi:file/file',
      url: `${baseUrl}/file/file`,
      rationale: 'Creacion generica de entidad fichero, sin nodo anfitrion',
    },
  ];
};

/**
 * Dispara UN endpoint con los 10 bytes de la sonda y devuelve el veredicto.
 *
 * Nunca lanza: un endpoint que no responde es un dato del informe igual que un
 * 422, y abortar en el primer fallo dejaria sin sondear los siguientes —que es
 * exactamente la informacion que falta hoy—.
 */
const probeUpload = async (
  drupalApiConfig: DrupalApiConfig,
  candidate: UploadCandidate,
): Promise<ProbeOutcome> => {
  logger.log(`-> POST ${candidate.url}`);

  let response: AxiosResponse<unknown>;

  try {
    response = await axios.post<unknown>(candidate.url, PROBE_PAYLOAD, {
      headers: {
        ...buildJsonApiHeaders(drupalApiConfig),
        // Sobrescriben las de JSON:API: este endpoint recibe bytes crudos.
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `file; filename="${PROBE_FILENAME}"`,
      },
      timeout: drupalApiConfig.timeoutMs,
      validateStatus: () => true,
    });
  } catch (error: unknown) {
    return {
      label: candidate.label,
      url: candidate.url,
      status: 'SIN_RESPUESTA',
      uploadedUrl: null,
      detail: error instanceof Error ? error.message : 'Error desconocido',
    };
  }

  const isSuccess = response.status >= 200 && response.status < 300;

  if (!isSuccess) {
    console.log(
      `\n----- payload de error ${response.status} en ${candidate.label} -----`,
    );
    console.log(describePayload(response.data));

    return {
      label: candidate.label,
      url: candidate.url,
      status: response.status,
      uploadedUrl: null,
      detail: candidate.rationale,
    };
  }

  const uploadedUrl = readUploadedUrl(response.data as DrupalEntityResponse);

  console.log(
    `\n----- respuesta ${response.status} en ${candidate.label} -----`,
  );
  console.log(describePayload(response.data));

  if (uploadedUrl === null) {
    logger.warn(
      `${candidate.label} acepto la subida pero NO publico "data.attributes.uri.url": la estrategia obtendria una URL vacia.`,
    );
  } else {
    logger.log(`URL publica extraida: ${uploadedUrl}`);
  }

  return {
    label: candidate.label,
    url: candidate.url,
    status: response.status,
    uploadedUrl,
    detail: candidate.rationale,
  };
};

const main = async (): Promise<void> => {
  const shouldWrite = process.argv.includes(WRITE_FLAG);

  logger.log(
    '--- SONDA DE DIAGNOSTICO: subida binaria a Drupal (JSON:API) ---',
  );

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    // `strict: false` porque `DrupalApiConfig` es provider de `NodesModule` y no
    // del scope raiz; sin ello `app.get` no lo encuentra.
    const drupalApiConfig = app.get(DrupalApiConfig, { strict: false });
    const uuid = assertPreflight(drupalApiConfig, app.get(ConfigService));

    logger.log(
      `Destino: ${drupalApiConfig.baseUrl} · bundle ${PROBE_BUNDLE} · uuid ${uuid} · auth ${drupalApiConfig.authType}`,
    );

    // --- 1. Inventario real del nodo anfitrion. Siempre corre: es lectura.
    const relationshipNames = await inspectHostNode(drupalApiConfig, uuid);

    const candidates = buildUploadCandidates(
      drupalApiConfig,
      uuid,
      relationshipNames,
    );

    // --- 2a. Simulacion: se enumera lo que se enviaria y se para aqui.
    if (!shouldWrite) {
      logger.warn(
        `MODO SIMULACION (sin ${WRITE_FLAG}): no se enviara ningun byte a Drupal.`,
      );
      console.table(
        candidates.map(({ label, url, rationale }) => ({
          endpoint: label,
          url,
          motivo: rationale,
        })),
      );
      logger.warn(
        `Repite con "-- ${WRITE_FLAG}" para sondear estos ${candidates.length} endpoints con ${PROBE_PAYLOAD.length} bytes.`,
      );

      return;
    }

    // --- 2b. Sondeo real. Secuencial y no en paralelo: una bateria de POST
    //         simultaneos contra el portal de produccion es indistinguible de un
    //         abuso, y el orden de los resultados es parte del diagnostico.
    logger.warn(
      `MODO ESCRITURA: se enviaran ${PROBE_PAYLOAD.length} bytes a ${candidates.length} endpoints del portal REAL.`,
    );

    const outcomes: ProbeOutcome[] = [];

    for (const candidate of candidates) {
      outcomes.push(await probeUpload(drupalApiConfig, candidate));
    }

    // --- 3. Informe final.
    console.log('\n----- resumen del sondeo -----');
    console.table(
      outcomes.map(({ label, status, uploadedUrl, detail }) => ({
        endpoint: label,
        http: status,
        url_publica: uploadedUrl ?? '',
        nota: detail,
      })),
    );

    const accepted = outcomes.filter((outcome) => outcome.uploadedUrl !== null);

    if (accepted.length > 0) {
      logger.log(
        `DIAGNOSTICO: la subida ES posible. Endpoint utilizable: ${accepted[0]?.label ?? ''}.`,
      );
      logger.warn(
        `Quedan ${accepted.length} fichero(s) "${PROBE_FILENAME}" en el CMS: retiralos a mano.`,
      );

      return;
    }

    logger.error(
      'DIAGNOSTICO: ningun endpoint acepto el binario. Lee los payloads de arriba: ' +
        '403 apunta a permisos de la cuenta de servicio, 404 a que la ruta o el campo no existen, ' +
        '422 a que el campo existe pero rechaza el fichero (extension, tamano o cardinalidad).',
    );
    process.exitCode = 1;
  } finally {
    // Sin esto el proceso queda colgado del pool de conexiones de TypeORM.
    await app.close();
  }
};

main().catch((error: unknown) => {
  logger.error(
    error instanceof Error ? error.message : 'Error desconocido',
    error instanceof Error ? error.stack : undefined,
  );
  process.exitCode = 1;
});
