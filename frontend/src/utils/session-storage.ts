import type { SessionUser } from '@/types/auth';

// Modulo HOJA: no importa Pinia, ni Axios, ni Vue. Es deliberado.
//
// Tanto el store de sesion como el interceptor de `boot/axios.ts` necesitan leer
// el access token. Si el interceptor lo pidiera al store, se formaria el ciclo
// boot -> store -> service -> boot. Aislar aqui el acceso a `localStorage` lo
// rompe: ambos dependen de este archivo y este no depende de nadie.
//
// Se aparta de la regla "helpers puros, sin I/O" de frontend-architecture.md
// §2.1 por ese motivo concreto, y solo toca almacenamiento del navegador: nunca
// hace red.

const ACCESS_TOKEN_KEY = 'proto-do:access-token';
const REFRESH_TOKEN_KEY = 'proto-do:refresh-token';
const USER_KEY = 'proto-do:user';

/** Instantanea de la sesion persistida. */
export interface PersistedSession {
  accessToken: string | null;
  refreshToken: string | null;
  user: SessionUser | null;
}

// Toda lectura y escritura va con guarda: en modo incognito, con las cookies
// bloqueadas o con la cuota agotada, `localStorage` lanza excepcion.
const readItem = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeItem = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Sin persistencia disponible: la sesion sigue viva en memoria hasta recargar.
  }
};

const removeItem = (key: string): void => {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nada que limpiar si el almacenamiento no esta accesible.
  }
};

/** Token de acceso vigente, o `null`. Lo consume el interceptor de peticiones. */
export const readAccessToken = (): string | null => readItem(ACCESS_TOKEN_KEY);

export const readRefreshToken = (): string | null => readItem(REFRESH_TOKEN_KEY);

/** Usuario persistido. Devuelve `null` si el JSON esta corrupto. */
export const readUser = (): SessionUser | null => {
  const raw = readItem(USER_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
};

/** Sesion completa, para rehidratar el store al arrancar la aplicacion. */
export const readSession = (): PersistedSession => ({
  accessToken: readAccessToken(),
  refreshToken: readRefreshToken(),
  user: readUser(),
});

export const writeSession = (session: {
  accessToken: string;
  refreshToken: string;
  user: SessionUser;
}): void => {
  writeItem(ACCESS_TOKEN_KEY, session.accessToken);
  writeItem(REFRESH_TOKEN_KEY, session.refreshToken);
  writeItem(USER_KEY, JSON.stringify(session.user));
};

export const clearSession = (): void => {
  removeItem(ACCESS_TOKEN_KEY);
  removeItem(REFRESH_TOKEN_KEY);
  removeItem(USER_KEY);
};

/**
 * Cierto si la clave pertenece al namespace de sesion.
 *
 * La consume el listener de `storage` del store para ignorar escrituras ajenas
 * (el tema, por ejemplo). Se expone desde aqui, y no como tres constantes, para
 * que este modulo siga siendo el unico dueño de los nombres de clave.
 */
export const isSessionStorageKey = (key: string | null): boolean =>
  key === ACCESS_TOKEN_KEY || key === REFRESH_TOKEN_KEY || key === USER_KEY;
