import { Injectable } from '@nestjs/common';
import Handlebars from 'handlebars';

import { BRAND_TEXT_MUTED } from '@common/constants/email-brand.constants';
import { BrowserPoolService } from '@modules/nodes/services/browser-pool.service';
import { TELEMETRY_REPORT_TEMPLATE } from '@modules/telemetry/reports/telemetry-report.template';

import type {
  ModelBreakdownResponseDto,
  TelemetryHistoryItemResponseDto,
  TelemetrySummaryResponseDto,
} from '@modules/telemetry/dto/telemetry-report-response.dto';
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
}

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
          label: 'Tasa de éxito',
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
      })),
      totalCostUsd: usdFormat.format(input.summary.totalCostUsd),
      items: items.map((item) => ({
        createdAt: dateTimeFormat.format(new Date(item.createdAt)),
        flowName: item.flowName ?? item.flowId,
        nodeId: item.nodeId,
        aiModel: item.aiModel,
        promptTokens: integerFormat.format(item.promptTokens),
        completionTokens: integerFormat.format(item.completionTokens),
        reasoningTokens: integerFormat.format(item.reasoningTokens),
        estimatedCostUsd: usdFormat.format(item.estimatedCostUsd),
        isEstimated: item.isEstimated,
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
    const html = this.renderHtml(input);
    const context = await this.browserPool.createContext();

    try {
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: 'load' });

      return await page.pdf({
        format: 'A4',
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate:
          `<div style="width:100%;font-size:8px;text-align:center;color:${BRAND_TEXT_MUTED};">` +
          'Página <span class="pageNumber"></span> de <span class="totalPages"></span></div>',
        margin: { top: '18mm', bottom: '20mm', left: '14mm', right: '14mm' },
      });
    } finally {
      await context.close();
    }
  }
}
