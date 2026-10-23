import {
  TELEMETRY_ORIGIN_LABELS,
  TelemetryOperationOrigin,
} from '@modules/telemetry/enums/telemetry-origin.enum';

import type { TelemetryHistoryItemResponseDto } from '@modules/telemetry/dto/telemetry-report-response.dto';

/**
 * Texto de la columna "Flujo" de los informes: el nombre del flujo, su id si
 * el flujo no tiene nombre resoluble, o el origen cuando la inferencia no nacio
 * de ninguna ejecucion (asistente de prompts, migracion 049).
 */
export const describeTelemetrySource = (
  item: Pick<
    TelemetryHistoryItemResponseDto,
    'operationOrigin' | 'flowName' | 'flowId'
  >,
): string =>
  item.operationOrigin === TelemetryOperationOrigin.PROMPT_OPTIMIZATION
    ? TELEMETRY_ORIGIN_LABELS[item.operationOrigin]
    : (item.flowName ?? item.flowId ?? '—');
