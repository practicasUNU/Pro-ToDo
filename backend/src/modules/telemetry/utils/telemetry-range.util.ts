import { resolveDateRange } from '@common/utils/date-range.util';
import { DEFAULT_RANGE_DAYS } from '@modules/telemetry/dto/telemetry-query.dto';

import type { DateRange } from '@common/utils/date-range.util';

/** Rango semiabierto `[from, to)` sobre el que se agrega. */
export type TelemetryRange = DateRange;

/**
 * Rango de un informe de telemetria: `resolveDateRange` con los
 * `DEFAULT_RANGE_DAYS` de telemetria como ventana por defecto.
 *
 * @throws BadRequestException Si `from` no es anterior a `to`.
 */
export const resolveTelemetryRange = (
  query: { readonly from?: string; readonly to?: string },
  now: Date = new Date(),
): TelemetryRange => resolveDateRange(query, DEFAULT_RANGE_DAYS, now);
