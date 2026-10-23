import { TelemetryOperationOrigin } from '@modules/telemetry/enums/telemetry-origin.enum';
import {
  MAX_PDF_ROWS,
  TelemetryPdfRenderer,
} from '@modules/telemetry/reports/telemetry-pdf.renderer';

import type { BrowserPoolService } from '@modules/nodes/services/browser-pool.service';
import type {
  TelemetryHistoryItemResponseDto,
  TelemetrySummaryResponseDto,
} from '@modules/telemetry/dto/telemetry-report-response.dto';
import type { TelemetryPdfInput } from '@modules/telemetry/reports/telemetry-pdf.renderer';

const SUMMARY: TelemetrySummaryResponseDto = {
  range: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-23T00:00:00.000Z' },
  totalTokens: 1_600,
  totalCostUsd: 2.3,
  aiInvocations: 3,
  estimatedInvocations: 1,
  executionsTotal: 4,
  executionsSucceeded: 3,
  successRate: 0.75,
};

const buildItem = (
  overrides: Partial<TelemetryHistoryItemResponseDto> = {},
): TelemetryHistoryItemResponseDto => ({
  id: 'row-1',
  createdAt: '2026-10-22T08:30:00.000Z',
  operationOrigin: TelemetryOperationOrigin.FLOW_EXECUTION,
  executionId: 'exec-1',
  flowId: 'flow-1',
  flowName: 'Notiweb',
  nodeId: 'nodo_ia',
  aiProvider: 'GEMINI',
  aiModel: 'gemini-3.6-flash',
  promptTokens: 1_000,
  completionTokens: 500,
  reasoningTokens: 100,
  totalTokens: 1_600,
  promptRateUsd: 0.075,
  completionRateUsd: 0.3,
  reasoningRateUsd: 0.3,
  estimatedCostUsd: 0.000255,
  isEstimated: false,
  ...overrides,
});

const buildInput = (
  overrides: Partial<TelemetryPdfInput> = {},
): TelemetryPdfInput => ({
  range: {
    from: new Date('2026-10-01T00:00:00.000Z'),
    to: new Date('2026-10-23T00:00:00.000Z'),
  },
  summary: SUMMARY,
  breakdown: [
    {
      aiProvider: 'GEMINI',
      aiModel: 'gemini-3.6-flash',
      invocations: 3,
      promptTokens: 1_000,
      completionTokens: 500,
      reasoningTokens: 100,
      totalTokens: 1_600,
      costUsd: 2.3,
    },
  ],
  items: [buildItem()],
  truncated: false,
  requestedBy: 'editor@unuware.com',
  ...overrides,
});

/** Pool doble: una pagina que "imprime" un PDF minimo. */
const buildBrowserPool = () => {
  const page = {
    setContent: jest.fn().mockResolvedValue(undefined),
    pdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.7 fake')),
  };
  const context = {
    newPage: jest.fn().mockResolvedValue(page),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const pool = { createContext: jest.fn().mockResolvedValue(context) };

  return { pool, context, page };
};

describe('TelemetryPdfRenderer', () => {
  it('renderHtml deberia incluir KPIs, desglose, detalle y firma', () => {
    // 1. Arrange 📐
    const { pool } = buildBrowserPool();
    const renderer = new TelemetryPdfRenderer(
      pool as unknown as BrowserPoolService,
    );

    // 2. Act ⚙️
    const html = renderer.renderHtml(buildInput());

    // 3. Assert 🎯
    expect(html).toContain('Informe de consumo de IA');
    expect(html).toContain('Tasa de éxito');
    // Intl separa el signo con un espacio de no separacion (U+00A0).
    expect(html).toMatch(/75\s%/);
    expect(html).toContain('gemini-3.6-flash');
    expect(html).toContain('Notiweb');
    expect(html).toContain('editor@unuware.com');
    expect(html).toContain('Validación institucional');
  });

  it('renderHtml deberia escapar el HTML de los nombres de flujo', () => {
    // 1. Arrange 📐: el nombre lo escribe un operador.
    const { pool } = buildBrowserPool();
    const renderer = new TelemetryPdfRenderer(
      pool as unknown as BrowserPoolService,
    );

    // 2. Act ⚙️
    const html = renderer.renderHtml(
      buildInput({ items: [buildItem({ flowName: '<script>x</script>' })] }),
    );

    // 3. Assert 🎯
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renderHtml deberia etiquetar el consumo del asistente de prompts', () => {
    // 1. Arrange 📐: sin ejecucion, flujo ni nodo (migracion 049).
    const { pool } = buildBrowserPool();
    const renderer = new TelemetryPdfRenderer(
      pool as unknown as BrowserPoolService,
    );
    const item = buildItem({
      operationOrigin: TelemetryOperationOrigin.PROMPT_OPTIMIZATION,
      executionId: null,
      flowId: null,
      flowName: null,
      nodeId: null,
    });

    // 2. Act ⚙️
    const html = renderer.renderHtml(buildInput({ items: [item] }));

    // 3. Assert 🎯
    expect(html).toContain('<td>Optimización de prompt</td>');
    expect(html).toContain('<td class="mono">—</td>');
  });

  it('renderHtml deberia recortar el detalle en MAX_PDF_ROWS y avisarlo', () => {
    // 1. Arrange 📐
    const { pool } = buildBrowserPool();
    const renderer = new TelemetryPdfRenderer(
      pool as unknown as BrowserPoolService,
    );
    const items = Array.from({ length: MAX_PDF_ROWS + 5 }, (_, index) =>
      buildItem({ id: `row-${index}`, nodeId: `nodo_${index}` }),
    );

    // 2. Act ⚙️
    const html = renderer.renderHtml(buildInput({ items }));

    // 3. Assert 🎯
    expect(html).toContain(`nodo_${MAX_PDF_ROWS - 1}<`);
    expect(html).not.toContain(`nodo_${MAX_PDF_ROWS}<`);
    expect(html).toContain('exportación CSV');
  });

  it('renderHtml deberia indicar que no hay datos en un periodo vacio', () => {
    // 1. Arrange 📐
    const { pool } = buildBrowserPool();
    const renderer = new TelemetryPdfRenderer(
      pool as unknown as BrowserPoolService,
    );

    // 2. Act ⚙️
    const html = renderer.renderHtml(
      buildInput({
        breakdown: [],
        items: [],
        summary: { ...SUMMARY, successRate: null },
      }),
    );

    // 3. Assert 🎯
    expect(html).toContain('No hay inferencias registradas en el periodo.');
    expect(html).toContain('Sin datos');
  });

  it('render deberia imprimir un A4 y cerrar siempre el contexto', async () => {
    // 1. Arrange 📐
    const { pool, context, page } = buildBrowserPool();
    const renderer = new TelemetryPdfRenderer(
      pool as unknown as BrowserPoolService,
    );

    // 2. Act ⚙️
    const pdf = await renderer.render(buildInput());

    // 3. Assert 🎯
    expect(pdf.toString().startsWith('%PDF')).toBe(true);
    expect(page.pdf).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'A4', printBackground: true }),
    );
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it('render deberia cerrar el contexto aunque la impresion falle', async () => {
    // 1. Arrange 📐: un contexto sin cerrar es memoria residente de Chromium.
    const { pool, context, page } = buildBrowserPool();
    page.pdf.mockRejectedValue(new Error('Target closed'));
    const renderer = new TelemetryPdfRenderer(
      pool as unknown as BrowserPoolService,
    );

    // 2. Act ⚙️ + 3. Assert 🎯
    await expect(renderer.render(buildInput())).rejects.toThrow(
      'Target closed',
    );
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});
