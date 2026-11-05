import { ExecutionState } from '@core/fsm/types/fsm.enums';
import {
  ExecutionsPdfRenderer,
  MAX_EXECUTIONS_PDF_ROWS,
} from '@modules/workflows/reports/executions-pdf.renderer';

import type { BrowserPoolService } from '@modules/nodes/services/browser-pool.service';
import type { ExecutionExportRow } from '@modules/workflows/executions.service';
import type { ExecutionsPdfInput } from '@modules/workflows/reports/executions-pdf.renderer';

const FLOW_ID = 'b6c1f0d2-3e4a-4b5c-8d6e-7f8091a2b3c4';

const buildRow = (
  overrides: Partial<ExecutionExportRow> = {},
): ExecutionExportRow => ({
  executionId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  flowId: FLOW_ID,
  flowName: 'Notiweb',
  state: ExecutionState.EXITOSO,
  activeCursor: null,
  logFilePath: null,
  failureReason: null,
  startedAt: '2026-10-22T08:30:00.000Z',
  updatedAt: '2026-10-22T08:31:00.000Z',
  hasAlerts: false,
  ...overrides,
});

const buildInput = (
  overrides: Partial<ExecutionsPdfInput> = {},
): ExecutionsPdfInput => ({
  rows: [buildRow()],
  truncated: false,
  filters: {},
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

const buildRenderer = (): ExecutionsPdfRenderer =>
  new ExecutionsPdfRenderer(
    buildBrowserPool().pool as unknown as BrowserPoolService,
  );

describe('ExecutionsPdfRenderer', () => {
  it('renderHtml deberia incluir la tabla, la hora de Madrid y la firma', () => {
    // 1. Arrange 📐
    const renderer = buildRenderer();

    // 2. Act ⚙️
    const html = renderer.renderHtml(buildInput());

    // 3. Assert 🎯: 08:30 UTC de octubre son las 10:30 en Madrid (CEST).
    expect(html).toContain('Historial de ejecuciones');
    expect(html).toContain('<td>Notiweb</td>');
    expect(html).toContain('<td>Exitoso</td>');
    expect(html).toContain('10:30:00');
    expect(html).toContain('Generado por');
    expect(html).toContain('editor@unuware.com');
    expect(html).toContain('Periodo: todo el historial');
  });

  it('renderHtml deberia imprimir en castellano los filtros aplicados', () => {
    // 1. Arrange 📐: el nombre del flujo filtrado se resuelve con las filas.
    const renderer = buildRenderer();

    // 2. Act ⚙️
    const html = renderer.renderHtml(
      buildInput({
        rows: [buildRow({ state: ExecutionState.PAUSADO })],
        filters: {
          state: ExecutionState.PAUSADO,
          flowId: FLOW_ID,
          from: '2026-10-01',
          to: '2026-10-22',
          sortBy: 'updatedAt',
          sortOrder: 'ASC',
        },
      }),
    );

    // 3. Assert 🎯: un dia sin hora no se desplaza al anterior por la zona.
    expect(html).toContain('<strong>Estado:</strong> Pausado');
    expect(html).toContain('<strong>Flujo:</strong> Notiweb');
    expect(html).toContain(
      '<strong>Orden:</strong> Última actualización (ascendente)',
    );
    expect(html).toContain('1 de octubre de 2026 – 22 de octubre de 2026');
  });

  it('renderHtml sin filtros deberia declarar "Todos" y el orden por defecto', () => {
    // 1. Arrange 📐: un `sortOrder` sin columna lo ignora el servicio.
    const renderer = buildRenderer();

    // 2. Act ⚙️
    const html = renderer.renderHtml(
      buildInput({ filters: { sortOrder: 'ASC' } }),
    );

    // 3. Assert 🎯
    expect(html).toContain('<strong>Estado:</strong> Todos');
    expect(html).toContain('<strong>Flujo:</strong> Todos');
    expect(html).toContain('<strong>Orden:</strong> Inicio (descendente)');
  });

  it('renderHtml deberia caer al id del flujo si no hay filas que lo nombren', () => {
    // 1. Arrange 📐
    const renderer = buildRenderer();

    // 2. Act ⚙️
    const html = renderer.renderHtml(
      buildInput({ rows: [], filters: { flowId: FLOW_ID } }),
    );

    // 3. Assert 🎯
    expect(html).toContain(`<strong>Flujo:</strong> ${FLOW_ID}`);
  });

  it('renderHtml deberia escapar el HTML del nombre del flujo y del motivo', () => {
    // 1. Arrange 📐: ambos los escribe una persona.
    const renderer = buildRenderer();

    // 2. Act ⚙️
    const html = renderer.renderHtml(
      buildInput({
        rows: [
          buildRow({
            flowName: '<script>x</script>',
            failureReason: '<img src=x onerror=alert(1)>',
          }),
        ],
      }),
    );

    // 3. Assert 🎯
    expect(html).not.toContain('<script>x</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src&#x3D;x');
  });

  it('renderHtml deberia caer al id del flujo borrado y marcar las alertas', () => {
    // 1. Arrange 📐
    const renderer = buildRenderer();

    // 2. Act ⚙️
    const html = renderer.renderHtml(
      buildInput({
        rows: [
          buildRow({
            flowName: null,
            hasAlerts: true,
            state: ExecutionState.FALLIDO,
          }),
        ],
      }),
    );

    // 3. Assert 🎯
    expect(html).toContain(`<td>${FLOW_ID}</td>`);
    expect(html).toContain('<span class="alert">Sí</span>');
    expect(html).toContain('<td>Fallido</td>');
  });

  it('renderHtml deberia recortar en MAX_EXECUTIONS_PDF_ROWS y avisarlo', () => {
    // 1. Arrange 📐
    const renderer = buildRenderer();
    const rows = Array.from(
      { length: MAX_EXECUTIONS_PDF_ROWS + 5 },
      (_, index) => buildRow({ activeCursor: `nodo_${index}` }),
    );

    // 2. Act ⚙️
    const html = renderer.renderHtml(buildInput({ rows }));

    // 3. Assert 🎯
    expect(html).toContain(`nodo_${MAX_EXECUTIONS_PDF_ROWS - 1}<`);
    expect(html).not.toContain(`nodo_${MAX_EXECUTIONS_PDF_ROWS}<`);
    expect(html).toContain('exportación CSV');
  });

  it('renderHtml deberia avisar del corte cuando la consulta ya vino truncada', () => {
    // 1. Arrange 📐
    const renderer = buildRenderer();

    // 2. Act ⚙️
    const html = renderer.renderHtml(buildInput({ truncated: true }));

    // 3. Assert 🎯
    expect(html).toContain('primeras ejecuciones según el orden aplicado');
  });

  it('renderHtml no deberia avisar de corte ni pintar tabla sin filas', () => {
    // 1. Arrange 📐
    const renderer = buildRenderer();

    // 2. Act ⚙️
    const html = renderer.renderHtml(buildInput({ rows: [] }));

    // 3. Assert 🎯
    expect(html).toContain(
      'No hay ejecuciones que cumplan los filtros aplicados.',
    );
    expect(html).not.toContain('<table>');
    expect(html).not.toContain('primeras ejecuciones');
  });

  it('render deberia imprimir un A4 y cerrar siempre el contexto', async () => {
    // 1. Arrange 📐
    const { pool, context, page } = buildBrowserPool();
    const renderer = new ExecutionsPdfRenderer(
      pool as unknown as BrowserPoolService,
    );

    // 2. Act ⚙️
    const pdf = await renderer.render(buildInput());

    // 3. Assert 🎯
    expect(pdf.toString().startsWith('%PDF')).toBe(true);
    expect(page.setContent).toHaveBeenCalledWith(
      expect.stringContaining('Historial de ejecuciones'),
      { waitUntil: 'load' },
    );
    expect(page.pdf).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'A4', printBackground: true }),
    );
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it('render deberia cerrar el contexto aunque la impresion falle', async () => {
    // 1. Arrange 📐
    const { pool, context, page } = buildBrowserPool();
    page.pdf.mockRejectedValue(new Error('Target closed'));
    const renderer = new ExecutionsPdfRenderer(
      pool as unknown as BrowserPoolService,
    );

    // 2. Act ⚙️ + 3. Assert 🎯
    await expect(renderer.render(buildInput())).rejects.toThrow(
      'Target closed',
    );
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});
