import { Injectable } from '@nestjs/common';
import Handlebars from 'handlebars';

import { renderHtmlToPdf } from '@common/utils/html-to-pdf.util';
import { ExecutionState } from '@core/fsm/types/fsm.enums';
import { BrowserPoolService } from '@modules/nodes/services/browser-pool.service';
import { EXECUTIONS_REPORT_TEMPLATE } from '@modules/workflows/reports/executions-report.template';

import type {
  ExecutionSortKey,
  ExportExecutionsQueryDto,
} from '@modules/workflows/dto/list-executions-query.dto';
import type { ExecutionExportRow } from '@modules/workflows/executions.service';

/**
 * Filas del detalle que caben en el PDF, mismo criterio que la telemetria y la
 * auditoria: el volcado completo es el CSV y el PDF avisa cuando recorta.
 */
export const MAX_EXECUTIONS_PDF_ROWS = 2_000;

/** Zona en la que se leen las fechas del informe: la de la organizacion. */
const REPORT_TIME_ZONE = 'Europe/Madrid';

/** Texto de la celda cuando no consta el dato. */
const EMPTY_VALUE = '—';

/** `YYYY-MM-DD` sin hora: lo que envia el filtro de fechas del historial. */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Todo lo que el informe necesita, ya consultado. */
export interface ExecutionsPdfInput {
  readonly rows: readonly ExecutionExportRow[];
  /** Si la consulta ya se corto en `MAX_EXPORT_ROWS`. */
  readonly truncated: boolean;
  /** Filtros y orden con los que se pidio; se imprimen en la cabecera. */
  readonly filters: ExportExecutionsQueryDto;
  /** Correo de quien pide el informe, para el bloque de firma. */
  readonly requestedBy: string;
}

/**
 * Etiquetas en castellano de cada estado. Las mismas que pinta el historial
 * (`frontend/src/utils/execution-state-display.ts`), para que el papel diga lo
 * mismo que la pantalla; el CSV conserva el valor crudo porque se procesa.
 */
const STATE_LABELS: Readonly<Record<ExecutionState, string>> = {
  [ExecutionState.INACTIVO]: 'En cola',
  [ExecutionState.EN_PROCESO]: 'En proceso',
  [ExecutionState.PAUSADO]: 'Pausado',
  [ExecutionState.EXITOSO]: 'Exitoso',
  [ExecutionState.OMITIDO]: 'Omitido',
  [ExecutionState.FALLIDO]: 'Fallido',
  [ExecutionState.DESCARTADO]: 'Descartado',
};

/** Rotulos de las columnas de orden, iguales a las cabeceras de la tabla. */
const SORT_LABELS: Readonly<Record<ExecutionSortKey, string>> = {
  state: 'Estado',
  startedAt: 'Inicio',
  updatedAt: 'Última actualización',
};

const integerFormat = new Intl.NumberFormat('es-ES');
const dateTimeFormat = new Intl.DateTimeFormat('es-ES', {
  dateStyle: 'short',
  timeStyle: 'medium',
  timeZone: REPORT_TIME_ZONE,
});
// Una fecha sin hora es un dia de calendario, no un instante: se formatea en
// UTC para que el `2026-10-01` del filtro no salga como "30 de septiembre".
const dayFormat = new Intl.DateTimeFormat('es-ES', {
  dateStyle: 'long',
  timeZone: 'UTC',
});

const formatFilterDate = (value: string): string =>
  DATE_ONLY_PATTERN.test(value)
    ? dayFormat.format(new Date(value))
    : dateTimeFormat.format(new Date(value));

/** Periodo del filtro de inicio en una linea; sin fechas, el historial entero. */
const describePeriod = (filters: ExportExecutionsQueryDto): string => {
  const { from, to } = filters;

  if (from !== undefined && to !== undefined) {
    return `${formatFilterDate(from)} – ${formatFilterDate(to)}`;
  }
  if (from !== undefined) {
    return `desde el ${formatFilterDate(from)}`;
  }
  if (to !== undefined) {
    return `hasta el ${formatFilterDate(to)}`;
  }

  return 'todo el historial';
};

/**
 * Genera el informe PDF del historial de ejecuciones con el Chromium
 * compartido (`BrowserPoolService`), igual que los de telemetria y auditoria.
 * Recibe las MISMAS filas que el CSV, de modo que ambos ficheros cuentan lo
 * mismo que la tabla con los filtros aplicados.
 */
@Injectable()
export class ExecutionsPdfRenderer {
  /** Instancia AISLADA de Handlebars, como en `TelemetryPdfRenderer`. */
  private readonly template = Handlebars.create().compile(
    EXECUTIONS_REPORT_TEMPLATE,
    { strict: true },
  );

  constructor(private readonly browserPool: BrowserPoolService) {}

  /** HTML del informe. Publico para poder probarlo sin navegador. */
  public renderHtml(input: ExecutionsPdfInput, issuedAt = new Date()): string {
    const items = input.rows.slice(0, MAX_EXECUTIONS_PDF_ROWS);
    const omitted = input.rows.length - items.length;

    return this.template({
      periodLabel: describePeriod(input.filters),
      issuedAt: dateTimeFormat.format(issuedAt),
      filters: this.describeFilters(input),
      rowCount: integerFormat.format(input.rows.length),
      items: items.map((row) => ({
        executionId: row.executionId,
        // Sin nombre (flujo borrado), su identificador: igual que el CSV.
        flowName: row.flowName ?? row.flowId,
        flowId: row.flowId,
        state: STATE_LABELS[row.state] ?? row.state,
        startedAt: dateTimeFormat.format(new Date(row.startedAt)),
        updatedAt: dateTimeFormat.format(new Date(row.updatedAt)),
        activeCursor: row.activeCursor ?? EMPTY_VALUE,
        hasAlerts: row.hasAlerts,
        failureReason: row.failureReason ?? EMPTY_VALUE,
      })),
      truncatedNote:
        omitted > 0 || input.truncated
          ? `El detalle muestra las ${integerFormat.format(items.length)} primeras ejecuciones según el orden aplicado; acota los filtros o usa la exportación CSV para consultar el resto.`
          : '',
      requestedBy: input.requestedBy,
    });
  }

  /** PDF A4 del informe. El contexto de Chromium se cierra siempre. */
  public async render(input: ExecutionsPdfInput): Promise<Buffer> {
    return renderHtmlToPdf(this.browserPool, this.renderHtml(input));
  }

  /**
   * Filtros activos como pares rotulo/valor. Se listan TAMBIEN los ausentes
   * ("Todos") y el orden efectivo: un informe impreso no tiene la pantalla al
   * lado para recordar con que criterio se saco.
   */
  private describeFilters(
    input: ExecutionsPdfInput,
  ): { label: string; value: string }[] {
    const { filters } = input;
    // El nombre sale de las propias filas: con el filtro de flujo todas son de
    // ese flujo, y si no hay ninguna el informe cae a su identificador.
    const flowName =
      filters.flowId === undefined
        ? undefined
        : (input.rows.find((row) => row.flowId === filters.flowId)?.flowName ??
          filters.flowId);
    // Mismo orden efectivo que `ExecutionsService.buildCriteria`: sin
    // columna se ordena por inicio descendente y se ignora el sentido.
    const sortKey: ExecutionSortKey = filters.sortBy ?? 'startedAt';
    const sortOrder =
      filters.sortBy === undefined ? 'DESC' : (filters.sortOrder ?? 'DESC');

    return [
      {
        label: 'Estado',
        value:
          filters.state === undefined
            ? 'Todos'
            : (STATE_LABELS[filters.state] ?? filters.state),
      },
      { label: 'Flujo', value: flowName ?? 'Todos' },
      {
        label: 'Orden',
        value: `${SORT_LABELS[sortKey]} (${sortOrder === 'ASC' ? 'ascendente' : 'descendente'})`,
      },
    ];
  }
}
