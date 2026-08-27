// Helper puro de presentacion (frontend-architecture.md §2.1): sin estado ni I/O.
//
// El backend persiste TIMESTAMP en UTC y lo serializa en ISO-8601. Pintar esa
// cadena tal cual mostraria la hora de Madrid a un usuario de Quito con tres
// horas de desfase, y el desfase seria invisible: la cadena parece una hora
// normal. `Intl.DateTimeFormat` sin `timeZone` explicito resuelve al huso del
// navegador, que es justo lo que se quiere.
//
// Se usa `Intl` y no `date.formatDate` de Quasar a proposito: `formatDate` NO
// convierte husos, solo da formato al `Date` que recibe, asi que no resolveria
// el problema por si solo.

/** Fechas soportadas: ISO-8601 del backend, epoch en ms, o `Date` ya construido. */
export type DateInput = string | number | Date | null | undefined;

/** Marcador para fechas ausentes o ilegibles, igual que en `user-display.ts`. */
const EMPTY_DATE = '—';

const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
};

const DATE_ONLY_OPTIONS: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
};

/**
 * Normaliza la entrada a `Date`, o `null` si no representa un instante valido.
 *
 * Una cadena ISO sin sufijo de zona (`2026-08-26T10:00:00`) la interpreta el
 * navegador como hora LOCAL, no UTC. Si el backend la envia asi, se le añade la
 * `Z` para que se lea como UTC, que es como esta almacenada.
 */
const toDate = (value: DateInput): Date | null => {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number') {
    const fromEpoch = new Date(value);
    return Number.isNaN(fromEpoch.getTime()) ? null : fromEpoch;
  }

  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  const normalized = hasTimezone ? value : `${value}Z`;
  const parsed = new Date(normalized);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/** Fecha y hora en el huso local del cliente (`26/08/2026, 14:30`). */
export const formatDateTime = (value: DateInput): string => {
  const date = toDate(value);
  if (!date) return EMPTY_DATE;

  return new Intl.DateTimeFormat(undefined, DATE_TIME_OPTIONS).format(date);
};

/** Solo la fecha, sin hora (`26/08/2026`). */
export const formatDate = (value: DateInput): string => {
  const date = toDate(value);
  if (!date) return EMPTY_DATE;

  return new Intl.DateTimeFormat(undefined, DATE_ONLY_OPTIONS).format(date);
};

/**
 * Nombre del huso resuelto por el navegador (`Europe/Madrid`).
 * Util para rotular una columna de fechas y que nadie dude de que hora esta viendo.
 */
export const getLocalTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone;
