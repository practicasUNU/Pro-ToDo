// Helpers puros de presentacion (frontend-architecture.md §2.1) para las cifras
// del dashboard de consumo. Locale fijo `es-ES`: es el de la organizacion, y
// un separador de miles que cambiase con el navegador haria ilegibles las
// capturas que se comparten entre equipos.

const LOCALE = 'es-ES';

/** Marcador para un valor que no existe (p. ej. tasa sin ejecuciones). */
export const EMPTY_VALUE = '—';

const integerFormat = new Intl.NumberFormat(LOCALE);

/**
 * Coste en dolares. Hasta seis decimales: una inferencia de Gemini cuesta
 * fracciones de centimo, y redondear a dos la pintaria como "0,00 US$".
 */
const usdFormat = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

const percentFormat = new Intl.NumberFormat(LOCALE, {
  style: 'percent',
  maximumFractionDigits: 1,
});

export const formatInteger = (value: number): string => integerFormat.format(value);

export const formatUsd = (value: number): string => usdFormat.format(value);

/** Fraccion entre 0 y 1 a porcentaje; `null` es "sin datos", no 0 %. */
export const formatPercent = (value: number | null): string =>
  value === null ? EMPTY_VALUE : percentFormat.format(value);
