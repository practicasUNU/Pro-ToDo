import { ExecutionState } from '@core/fsm/types/fsm.enums';
import {
  CSV_HEADERS,
  buildExecutionsCsv,
} from '@modules/workflows/reports/executions-csv.builder';

import type { ExecutionExportRow } from '@modules/workflows/executions.service';

const buildRow = (
  overrides: Partial<ExecutionExportRow> = {},
): ExecutionExportRow => ({
  executionId: 'e1b2c3d4-0000-4000-8000-000000000001',
  flowId: 'f1b2c3d4-0000-4000-8000-000000000002',
  flowName: 'Notiweb',
  state: ExecutionState.PAUSADO,
  activeCursor: 'nodo_ia',
  logFilePath: 'logs/execution-2026-10-22.log',
  failureReason: 'El nodo fallo (GRAVE).',
  startedAt: '2026-10-22T08:30:00.000Z',
  updatedAt: '2026-10-22T08:31:00.000Z',
  hasAlerts: true,
  ...overrides,
});

/** Texto del CSV sin la BOM, partido en registros. */
const recordsOf = (csv: Buffer): string[] =>
  csv
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .split('\r\n');

describe('executions-csv.builder', () => {
  it('deberia empezar por la BOM UTF-8 para que Excel lea los acentos', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const csv = buildExecutionsCsv([]);

    // 3. Assert 🎯
    expect(csv.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  it('deberia escribir la cabecera en castellano separada por punto y coma', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const [header] = recordsOf(buildExecutionsCsv([]));

    // 3. Assert 🎯
    expect(header).toBe(CSV_HEADERS.join(';'));
    expect(header).toBe(
      'Ejecución;Flujo;ID flujo;Estado;Inicio;Última actualización;Paso actual;Alertas;Motivo',
    );
  });

  it('deberia escribir una fila por ejecucion con las fechas en ISO 8601', () => {
    // 1. Arrange 📐
    const rows = [
      buildRow(),
      buildRow({
        state: ExecutionState.EXITOSO,
        activeCursor: null,
        failureReason: null,
        hasAlerts: false,
      }),
    ];

    // 2. Act ⚙️
    const records = recordsOf(buildExecutionsCsv(rows));

    // 3. Assert 🎯: cabecera + 2 filas + linea vacia final (CRLF de cierre).
    expect(records).toHaveLength(4);
    expect(records[1]).toBe(
      'e1b2c3d4-0000-4000-8000-000000000001;Notiweb;f1b2c3d4-0000-4000-8000-000000000002;PAUSADO;2026-10-22T08:30:00.000Z;2026-10-22T08:31:00.000Z;nodo_ia;Sí;El nodo fallo (GRAVE).',
    );
    expect(
      records[2]?.endsWith(
        ';EXITOSO;2026-10-22T08:30:00.000Z;2026-10-22T08:31:00.000Z;;No;',
      ),
    ).toBe(true);
  });

  it('deberia usar el id del flujo cuando ya no existe su nombre', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const [, record] = recordsOf(
      buildExecutionsCsv([buildRow({ flowName: null })]),
    );

    // 3. Assert 🎯
    expect(record?.split(';')[1]).toBe('f1b2c3d4-0000-4000-8000-000000000002');
  });

  it('deberia entrecomillar separadores, comillas y saltos (RFC 4180)', () => {
    // 1. Arrange 📐
    const row = buildRow({
      flowName: 'Prensa; "Notiweb"',
      failureReason: 'linea\nnueva',
    });

    // 2. Act ⚙️
    const csv = buildExecutionsCsv([row]).toString('utf8');

    // 3. Assert 🎯
    expect(csv).toContain(';"Prensa; ""Notiweb""";');
    expect(csv).toContain(';"linea\nnueva"\r\n');
  });

  it('deberia neutralizar las formulas en los textos que escribe un operador (inyeccion CSV)', () => {
    // 1. Arrange 📐: el nombre del flujo y el motivo los escribe una persona.
    const row = buildRow({
      flowName: '=HYPERLINK("http://x")',
      failureReason: '@SUM(A1)',
      activeCursor: '+nodo',
    });

    // 2. Act ⚙️
    const [, record] = recordsOf(buildExecutionsCsv([row]));

    // 3. Assert 🎯
    expect(record).toContain(`;"'=HYPERLINK(""http://x"")";`);
    expect(record).toContain(";'+nodo;");
    expect(record?.endsWith(";'@SUM(A1)")).toBe(true);
  });
});
