// Replica exacta de `HttpGenericDestinationConfigDto`
// (backend `modules/nodes/dto/http-generic-destination-config.dto.ts`). El DTO
// valida con `forbidNonWhitelisted`, asi que aqui viven EXACTAMENTE sus claves:
// una de mas es un 400 al guardar el flujo.

/** Replica de `HttpGenericMethod`. */
export enum HttpGenericMethod {
  GET = 'GET',
  POST = 'POST',
  PUT = 'PUT',
  PATCH = 'PATCH',
  DELETE = 'DELETE',
}

/** Replica de `HttpGenericBodyType`. */
export enum HttpGenericBodyType {
  JSON = 'JSON',
  RAW_TEXT = 'RAW_TEXT',
  FORM_DATA = 'FORM_DATA',
  NONE = 'NONE',
}

/** Replica de `HttpGenericAuthType`. Todo lo que no es `NONE` exige credencial. */
export enum HttpGenericAuthType {
  NONE = 'NONE',
  BEARER_TOKEN = 'BEARER_TOKEN',
  BASIC_AUTH = 'BASIC_AUTH',
  API_KEY = 'API_KEY',
}

export const DEFAULT_HTTP_GENERIC_METHOD = HttpGenericMethod.POST;
export const DEFAULT_HTTP_GENERIC_BODY_TYPE = HttpGenericBodyType.JSON;
export const DEFAULT_HTTP_GENERIC_AUTH_TYPE = HttpGenericAuthType.NONE;
export const DEFAULT_HTTP_GENERIC_TIMEOUT_MS = 15_000;
export const MIN_HTTP_GENERIC_TIMEOUT_MS = 1_000;
export const MAX_HTTP_GENERIC_TIMEOUT_MS = 60_000;
/** Reintentos por defecto de POST/PATCH: repetirlos puede duplicar en el remoto. */
export const DEFAULT_HTTP_GENERIC_RETRY_ATTEMPTS = 0;
/** Reintentos por defecto de GET/PUT/DELETE, idempotentes (replica del backend). */
export const DEFAULT_HTTP_GENERIC_IDEMPOTENT_RETRY_ATTEMPTS = 3;
export const MAX_HTTP_GENERIC_RETRY_ATTEMPTS = 5;
export const MAX_TARGET_URL_LENGTH = 2048;
export const MAX_BODY_TEMPLATE_LENGTH = 100_000;
export const MAX_KEY_VALUE_ENTRIES = 20;
export const MAX_KEY_VALUE_VALUE_LENGTH = 2_000;

/** Replica de `KEY_VALUE_NAME_PATTERN`. */
export const KEY_VALUE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/** Replica de `QUERY_PARAM_NAME_PATTERN`: admite los corchetes de JSON:API. */
export const QUERY_PARAM_NAME_PATTERN = /^[A-Za-z0-9_.[\]-]{1,100}$/;

/**
 * Replica de `TARGET_URL_PATTERN`: URL absoluta http(s), o una que EMPIEZA por
 * un marcador (la direccion entera sale de un paso anterior).
 */
export const TARGET_URL_PATTERN =
  /^(?:https?:\/\/\S+|\{\{\s*[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+|\[\d+\])+\s*\}\}\S*)$/i;

/** Replica de `FORBIDDEN_HEADER_NAMES`: la autenticacion va SOLO por credencial. */
export const FORBIDDEN_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
]);

/**
 * Marcador `{{ns.campo}}`, con la gramatica de `MARKER_PATTERN`
 * (`@/utils/codemirror-markers`). Se repite aqui en vez de importarlo para no
 * arrastrar CodeMirror al store de un nodo; el grupo 1 es el namespace y el 2
 * el primer segmento del campo.
 */
// El indice va PEGADO al campo (`{{ns.urls[0]}}`), como en el
// `INTERPOLATION_PATTERN` del backend. La version anterior exigia un punto
// delante (`.[0]`), asi que `{{parsed_email.extracted_urls[0]}}` no casaba: el
// marcador ni se validaba ni se reconocia como variable.
export const HTTP_MARKER_PATTERN =
  /\{\{\s*([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)(?:\.[a-zA-Z0-9_]+|\[\d+\])*\s*\}\}/g;

/** Una fila del editor de cabeceras o parametros. */
export interface KeyValueRow {
  readonly name: string;
  readonly value: string;
}

/**
 * Configuracion del nodo en el asistente.
 *
 * `headers` y `queryParams` son FILAS y no `Record` mientras se editan: una
 * fila a medio escribir (nombre vacio) o dos con el mismo nombre deben poder
 * existir en pantalla para que el operador las corrija; en el `Record` del
 * esquema se perderian en silencio. `toNodeParams` las convierte.
 *
 * Sin opcionales: la ausencia es `null` (convencion del resto de nodos).
 */
export interface HttpGenericDestinationNodeConfig {
  targetUrl: string | null;
  method: HttpGenericMethod;
  headers: readonly KeyValueRow[];
  queryParams: readonly KeyValueRow[];
  bodyType: HttpGenericBodyType;
  bodyTemplate: string | null;
  authType: HttpGenericAuthType;
  credentialId: string | null;
  timeoutMs: number;
  retryAttempts: number;
}

/** Verbos que se pueden repetir sin efecto adicional (replica de `IDEMPOTENT_HTTP_GENERIC_METHODS`). */
export const IDEMPOTENT_HTTP_GENERIC_METHODS: ReadonlySet<HttpGenericMethod> = new Set([
  HttpGenericMethod.GET,
  HttpGenericMethod.PUT,
  HttpGenericMethod.DELETE,
]);

/** Reintentos que aplica el backend cuando el nodo no declara `retryAttempts`. */
export const defaultRetryAttemptsFor = (method: HttpGenericMethod): number =>
  IDEMPOTENT_HTTP_GENERIC_METHODS.has(method)
    ? DEFAULT_HTTP_GENERIC_IDEMPOTENT_RETRY_ATTEMPTS
    : DEFAULT_HTTP_GENERIC_RETRY_ATTEMPTS;

/**
 * Cabeceras sugeridas en el selector de nombre. El operador puede escribir otra.
 *
 * `Authorization` NO esta: la autenticacion entra solo por credencial de la
 * boveda (`FORBIDDEN_HEADER_NAMES`). Su texto de ayuda si existe, para explicar
 * por que se rechaza si alguien la escribe a mano.
 */
export const HEADER_NAME_PRESETS: readonly string[] = [
  'Content-Type',
  'Accept',
  'User-Agent',
  'X-Api-Key',
];

/** Valores sugeridos para las cabeceras de tipo de contenido. */
export const HEADER_VALUE_PRESETS: readonly string[] = [
  'application/json',
  'application/vnd.api+json',
];

/** Parametros de consulta sugeridos (convencion JSON:API de Drupal). */
export const QUERY_PARAM_NAME_PRESETS: readonly string[] = [
  'page[number]',
  'page[size]',
  'filter[search]',
  'sort',
  'include',
];

/** Ayuda por nombre de cabecera, con la clave en minusculas. */
const HEADER_NAME_HELP: Readonly<Record<string, string>> = {
  'content-type': 'Indica al servidor remoto en que formato va el contenido que se le envia.',
  accept: 'Especifica al servidor que tipo de respuesta espera recibir el cliente (ej: JSON).',
  authorization:
    'Envia las credenciales o el token de acceso que autentican la peticion. En este nodo no se escribe a mano: elige una credencial de la boveda en el bloque de autenticacion, para que el secreto no quede en claro en el flujo.',
  'user-agent': 'Identifica ante el servidor remoto el programa que hace la peticion.',
  'x-api-key':
    'Clave de API que algunos servicios exigen en una cabecera propia. Si es un secreto, mejor guardarla como credencial de tipo API key.',
};

/** Ayuda por par cabecera/valor, para los valores que cambian el sentido. */
const HEADER_VALUE_HELP: Readonly<Record<string, string>> = {
  'content-type: application/json':
    'Indica al servidor remoto que el cuerpo de la peticion contiene una estructura de datos JSON estandar.',
  'content-type: application/vnd.api+json':
    'Indica al servidor remoto que el formato del contenido enviado cumple con el estandar estricto de JSON:API (requerido por Drupal).',
  'accept: application/json': 'Pide al servidor que responda con JSON estandar.',
  'accept: application/vnd.api+json':
    'Pide al servidor que responda siguiendo el estandar JSON:API (Drupal).',
};

/** Ayuda por parametro de consulta. */
const QUERY_PARAM_HELP: Readonly<Record<string, string>> = {
  'page[number]': 'Numero de pagina de resultados que se pide (paginacion JSON:API).',
  'page[size]': 'Cuantos resultados devuelve cada pagina (paginacion JSON:API).',
  'filter[search]': 'Texto por el que el servidor filtra los resultados antes de devolverlos.',
  sort: 'Campo por el que se ordenan los resultados; con un "-" delante, en orden descendente.',
  include: 'Relaciones que el servidor debe incluir en la misma respuesta, separadas por comas.',
};

/** Texto de ayuda de una cabecera; `null` si no hay ninguno para ese nombre. */
export const describeHeader = (row: KeyValueRow): string | null => {
  const name = row.name.trim().toLowerCase();
  const value = row.value.trim().toLowerCase();

  return HEADER_VALUE_HELP[`${name}: ${value}`] ?? HEADER_NAME_HELP[name] ?? null;
};

/** Texto de ayuda de un parametro de consulta; `null` si no hay ninguno. */
export const describeQueryParam = (row: KeyValueRow): string | null =>
  QUERY_PARAM_HELP[row.name.trim().toLowerCase()] ?? null;
