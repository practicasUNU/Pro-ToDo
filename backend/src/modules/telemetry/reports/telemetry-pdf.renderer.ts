import { Injectable } from '@nestjs/common';
import Handlebars from 'handlebars';

import { renderHtmlToPdf } from '@common/utils/html-to-pdf.util';
import { BrowserPoolService } from '@modules/nodes/services/browser-pool.service';
import { AI_CALL_STATUS_LABELS } from '@modules/telemetry/enums/ai-call-status.enum';
import { TELEMETRY_REPORT_TEMPLATE } from '@modules/telemetry/reports/telemetry-report.template';
import { describeTelemetrySource } from '@modules/telemetry/reports/telemetry-source.util';

import type {
  ModelBreakdownResponseDto,
  TelemetryHistoryItemResponseDto,
  TelemetrySummaryResponseDto,
} from '@modules/telemetry/dto/telemetry-report-response.dto';
import type { TelemetryExportQueryDto } from '@modules/telemetry/dto/telemetry-query.dto';
import type { TelemetryRange } from '@modules/telemetry/utils/telemetry-range.util';

/**
 * Filas del detalle que caben en el PDF.
 *
 * Un PDF es para leerlo, no para analizarlo: por encima de unas decenas de
 * paginas nadie lo recorre, y Chromium tarda segundos por cada centenar de
 * filas. El volcado completo es el CSV; el PDF avisa cuando recorta.
 */
export const MAX_PDF_ROWS = 2_000;

/** Zona en la que se leen las fechas del informe: la de la organizacion. */
const REPORT_TIME_ZONE = 'Europe/Madrid';

/** Todo lo que el informe necesita, ya consultado. */
export interface TelemetryPdfInput {
  readonly range: TelemetryRange;
  readonly summary: TelemetrySummaryResponseDto;
  readonly breakdown: readonly ModelBreakdownResponseDto[];
  readonly items: readonly TelemetryHistoryItemResponseDto[];
  /** Si la consulta ya se corto en `MAX_EXPORT_ROWS`. */
  readonly truncated: boolean;
  /** Correo de quien pide el informe, para el bloque de firma. */
  readonly requestedBy: string;
  /** Filtros y orden con los que se pidio; se imprimen en la cabecera. */
  readonly filters?: TelemetryExportQueryDto;
}

/** Etiquetas de los criterios de orden, para la cabecera del informe. */
const SORT_LABELS: Readonly<Record<string, string>> = {
  invocations: 'Invocaciones',
  promptTokens: 'Tokens de prompt',
  completionTokens: 'Tokens de completación',
  reasoningTokens: 'Tokens de razonamiento',
  totalTokens: 'Tokens totales',
  costUsd: 'Coste (USD)',
  estimatedCostUsd: 'Coste (USD)',
  createdAt: 'Fecha',
  flow: 'Flujo',
  nodeId: 'Nodo',
  aiProvider: 'Proveedor',
  aiModel: 'Modelo',
  status: 'Estado',
  user: 'Usuario',
};

/**
 * Filtros activos en una linea legible ("Proveedor: GEMINI · Modelo: ...").
 * Vacio si no hay ninguno: la plantilla omite entonces la linea.
 */
const describeFilters = (
  filters: TelemetryExportQueryDto | undefined,
): string => {
  if (filters === undefined) {
    return '';
  }

  const describeSort = (
    key: string | undefined,
    order: string | undefined,
  ): string =>
    `${SORT_LABELS[key ?? ''] ?? key ?? ''} (${order === 'ASC' ? 'menor a mayor' : 'mayor a menor'})`;

  return [
    filters.aiProvider !== undefined
      ? `Proveedor: ${filters.aiProvider}`
      : null,
    filters.aiModel !== undefined ? `Modelo: ${filters.aiModel}` : null,
    filters.flowId !== undefined ? `Flujo: ${filters.flowId}` : null,
    filters.nodeId !== undefined ? `Nodo: ${filters.nodeId}` : null,
    filters.breakdownSortBy !== undefined
      ? `Desglose ordenado por ${describeSort(filters.breakdownSortBy, filters.breakdownSortOrder)}`
      : null,
    filters.sortBy !== undefined
      ? `Detalle ordenado por ${describeSort(filters.sortBy, filters.sortOrder)}`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
};

const integerFormat = new Intl.NumberFormat('es-ES');
const usdFormat = new Intl.NumberFormat('es-ES', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});
const percentFormat = new Intl.NumberFormat('es-ES', {
  style: 'percent',
  maximumFractionDigits: 1,
});
const dateTimeFormat = new Intl.DateTimeFormat('es-ES', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: REPORT_TIME_ZONE,
});
const dateFormat = new Intl.DateTimeFormat('es-ES', {
  dateStyle: 'long',
  timeZone: REPORT_TIME_ZONE,
});

/**
 * Genera el informe PDF de telemetria con el Chromium que ya comparte el
 * proyecto (`BrowserPoolService`): HTML -> `page.pdf()`, vectorial y sin
 * dependencias nuevas.
 *
 * La plantilla no referencia ningun recurso externo, asi que el bloqueo de
 * imagenes y fuentes del contexto del pool no le afecta.
 */
@Injectable()
export class TelemetryPdfRenderer {
  /**
   * Instancia AISLADA de Handlebars: los helpers o parciales que otro modulo
   * registre en la global no deben poder alterar este informe.
   */
  private readonly template = Handlebars.create().compile(
    TELEMETRY_REPORT_TEMPLATE,
    { strict: true },
  );

  constructor(private readonly browserPool: BrowserPoolService) {}

  /** HTML del informe. Publico para poder probarlo sin navegador. */
  public renderHtml(input: TelemetryPdfInput, issuedAt = new Date()): string {
    const items = input.items.slice(0, MAX_PDF_ROWS);
    const omitted = input.items.length - items.length;

    return this.template({
      rangeLabel: `${dateFormat.format(input.range.from)} – ${dateFormat.format(
        // El fin es exclusivo: se muestra el ultimo instante incluido.
        new Date(input.range.to.getTime() - 1),
      )}`,
      issuedAt: dateTimeFormat.format(issuedAt),
      filtersLabel: describeFilters(input.filters),
      kpis: [
        {
          label: 'Tokens totales',
          value: integerFormat.format(input.summary.totalTokens),
        },
        {
          label: 'Coste total',
          value: usdFormat.format(input.summary.totalCostUsd),
        },
        {
          label: 'Invocaciones IA',
          value: integerFormat.format(input.summary.aiInvocations),
        },
        {
          label: 'Tasa de éxito de flujos con IA',
          value:
            input.summary.successRate === null
              ? 'Sin datos'
              : percentFormat.format(input.summary.successRate),
        },
      ],
      breakdown: input.breakdown.map((row) => ({
        aiProvider: row.aiProvider,
        aiModel: row.aiModel,
        invocations: integerFormat.format(row.invocations),
        totalTokens: integerFormat.format(row.totalTokens),
        costUsd: usdFormat.format(row.costUsd),
        failed: integerFormat.format(row.failed),
        successRate:
          row.successRate === null
            ? '—'
            : percentFormat.format(row.successRate),
      })),
      totalCostUsd: usdFormat.format(input.summary.totalCostUsd),
      items: items.map((item) => ({
        createdAt: dateTimeFormat.format(new Date(item.createdAt)),
        flowName: describeTelemetrySource(item),
        nodeId: item.nodeId ?? '—',
        aiModel: item.aiModel,
        promptTokens: integerFormat.format(item.promptTokens),
        completionTokens: integerFormat.format(item.completionTokens),
        reasoningTokens: integerFormat.format(item.reasoningTokens),
        estimatedCostUsd: usdFormat.format(item.estimatedCostUsd),
        isEstimated: item.isEstimated,
        userEmail: item.userEmail ?? '—',
        status: AI_CALL_STATUS_LABELS[item.status],
      })),
      truncatedNote:
        omitted > 0 || input.truncated
          ? `El detalle muestra las ${integerFormat.format(items.length)} inferencias más recientes del periodo. Los totales y el desglose sí cubren el periodo completo; el detalle íntegro está en la exportación CSV.`
          : '',
      requestedBy: input.requestedBy,
    });
  }

  /** PDF A4 del informe. El contexto de Chromium se cierra siempre. */
  public async render(input: TelemetryPdfInput): Promise<Buffer> {
    return renderHtmlToPdf(this.browserPool, this.renderHtml(input));
  }
}
