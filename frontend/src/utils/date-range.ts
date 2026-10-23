// Helper puro (frontend-architecture.md §2.1): convierte el rango que elige el
// usuario en un `<input type="date">` en los instantes que espera la API.

/** Dias que cubre el informe por defecto, igual que el backend. */
export const DEFAULT_RANGE_DAYS = 30;

/** Rango tal como lo edita el usuario: fechas `YYYY-MM-DD` en su huso local. */
export interface DateRangeInput {
  readonly from: string;
  readonly to: string;
}

/** Rango listo para la API: instantes ISO, `to` EXCLUIDO. */
export interface IsoRange {
  readonly from: string;
  readonly to: string;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** `Date` local a `YYYY-MM-DD`, sin pasar por UTC. */
export const toDateInputValue = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** Medianoche LOCAL del dia `YYYY-MM-DD`, o `null` si no es una fecha valida. */
const localMidnight = (value: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (match === null) return null;

  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));

  return Number.isNaN(date.getTime()) ? null : date;
};

/** Los ultimos `days` dias, hoy incluido. */
export const defaultDateRange = (
  now: Date = new Date(),
  days: number = DEFAULT_RANGE_DAYS,
): DateRangeInput => {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));

  return { from: toDateInputValue(from), to: toDateInputValue(now) };
};

/**
 * Rango de fechas locales a instantes ISO para la API.
 *
 * Se convierte AQUI y no se envia `YYYY-MM-DD` tal cual: el backend leeria esa
 * fecha como medianoche UTC, y un usuario de Madrid perderia las dos primeras
 * horas de su primer dia. El fin avanza un dia porque la API lo trata como
 * exclusivo y quien elige "hasta el 22" quiere el 22 entero.
 *
 * @returns `null` si alguna fecha no es valida o el rango esta invertido.
 */
export const toIsoRange = (range: DateRangeInput): IsoRange | null => {
  const from = localMidnight(range.from);
  const toDay = localMidnight(range.to);

  if (from === null || toDay === null) return null;

  const to = new Date(toDay.getFullYear(), toDay.getMonth(), toDay.getDate() + 1);

  if (from.getTime() >= to.getTime()) return null;

  return { from: from.toISOString(), to: to.toISOString() };
};
