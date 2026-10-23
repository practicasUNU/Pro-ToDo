import { BadRequestException } from '@nestjs/common';

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` sin hora: lo que envia un `<input type="date">`. */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Rango semiabierto `[from, to)` de un informe. */
export interface DateRange {
  readonly from: Date;
  readonly to: Date;
}

/**
 * Resuelve el rango de un informe a partir de `from` / `to` opcionales.
 *
 * El fin es EXCLUSIVO, y por eso una fecha sin hora en `to` avanza un dia: quien
 * pide "hasta el 22" espera ver lo ocurrido a las 23:59 del 22. Sin `to`, el
 * rango acaba ahora; sin `from`, empieza `defaultDays` antes del fin.
 *
 * @throws BadRequestException Si `from` no es anterior a `to`: un rango vacio o
 *         invertido devolveria ceros que parecen un dato.
 */
export const resolveDateRange = (
  query: { readonly from?: string; readonly to?: string },
  defaultDays: number,
  now: Date = new Date(),
): DateRange => {
  const to =
    query.to === undefined
      ? now
      : DATE_ONLY_PATTERN.test(query.to)
        ? new Date(new Date(query.to).getTime() + DAY_MS)
        : new Date(query.to);

  const from =
    query.from === undefined
      ? new Date(to.getTime() - defaultDays * DAY_MS)
      : new Date(query.from);

  if (from.getTime() >= to.getTime()) {
    throw new BadRequestException(
      'El inicio del rango (from) debe ser anterior a su fin (to).',
    );
  }

  return { from, to };
};
