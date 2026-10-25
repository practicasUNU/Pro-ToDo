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
export const DEFAULT_HTTP_GENERIC_RETRY_ATTEMPTS = 0;
export const MAX_HTTP_GENERIC_RETRY_ATTEMPTS = 5;
export const MAX_TARGET_URL_LENGTH = 2048;
export const MAX_BODY_TEMPLATE_LENGTH = 100_000;
export const MAX_KEY_VALUE_ENTRIES = 20;
export const MAX_KEY_VALUE_VALUE_LENGTH = 2_000;

/** Replica de `KEY_VALUE_NAME_PATTERN`. */
export const KEY_VALUE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/** Replica de `TARGET_URL_PATTERN`. */
export const TARGET_URL_PATTERN = /^https?:\/\/\S+$/i;

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
export const HTTP_MARKER_PATTERN =
  /\{\{\s*([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)(?:\.(?:[a-zA-Z0-9_]+|\[\d+\]))*\s*\}\}/g;

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
