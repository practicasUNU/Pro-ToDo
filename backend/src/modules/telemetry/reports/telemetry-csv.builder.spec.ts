import {
  CSV_HEADERS,
  buildTelemetryCsv,
  escapeCsvText,
  formatCsvDecimal,
} from '@modules/telemetry/reports/telemetry-csv.builder';

import type { TelemetryHistoryItemResponseDto } from '@modules/telemetry/dto/telemetry-report-response.dto';

const buildItem = (
  overrides: Partial<TelemetryHistoryItemResponseDto> = {},
): TelemetryHistoryItemResponseDto => ({
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  createdAt: '2026-10-22T08:30:00.000Z',
  executionId: 'e1b2c3d4-0000-4000-8000-000000000002',
  flowId: 'f1b2c3d4-0000-4000-8000-000000000003',
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

/** Texto del CSV sin la BOM, partido en registros. */
const recordsOf = (csv: Buffer): string[] =>
  csv
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .split('\r\n');

describe('telemetry-csv.builder', () => {
  it('deberia empezar por la BOM UTF-8 para que Excel lea los acentos', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const csv = buildTelemetryCsv([]);

    // 3. Assert 🎯
    expect(csv.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  it('deberia escribir la cabecera en castellano separada por punto y coma', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const [header] = recordsOf(buildTelemetryCsv([]));

    // 3. Assert 🎯
    expect(header).toBe(CSV_HEADERS.join(';'));
    expect(header).toContain('Tokens completación');
  });

  it('deberia escribir una fila por inferencia con coma decimal', () => {
    // 1. Arrange 📐
    const items = [buildItem(), buildItem({ isEstimated: true })];

    // 2. Act ⚙️
    const records = recordsOf(buildTelemetryCsv(items));

    // 3. Assert 🎯: cabecera + 2 filas + linea vacia final (CRLF de cierre).
    expect(records).toHaveLength(4);
    expect(records[1]).toBe(
      '2026-10-22T08:30:00.000Z;Notiweb;e1b2c3d4-0000-4000-8000-000000000002;nodo_ia;GEMINI;gemini-3.6-flash;1000;500;100;1600;0,075000;0,300000;0,300000;0,000255;No',
    );
    expect(records[2]?.endsWith(';Sí')).toBe(true);
  });

  it('deberia usar el id del flujo cuando no hay nombre', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const [, record] = recordsOf(
      buildTelemetryCsv([buildItem({ flowName: null })]),
    );

    // 3. Assert 🎯
    expect(record?.split(';')[1]).toBe('f1b2c3d4-0000-4000-8000-000000000003');
  });

  it('escapeCsvText deberia entrecomillar separadores, comillas y saltos (RFC 4180)', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(escapeCsvText('Flujo; A')).toBe('"Flujo; A"');
    expect(escapeCsvText('Dijo "hola"')).toBe('"Dijo ""hola"""');
    expect(escapeCsvText('linea\nnueva')).toBe('"linea\nnueva"');
    expect(escapeCsvText('normal')).toBe('normal');
  });

  it('escapeCsvText deberia neutralizar formulas (inyeccion CSV)', () => {
    // 1. Arrange 📐: un nombre de flujo lo escribe un operador.
    // 2. Act ⚙️ + 3. Assert 🎯
    expect(escapeCsvText('=HYPERLINK("http://x")')).toBe(
      `"'=HYPERLINK(""http://x"")"`,
    );
    expect(escapeCsvText('+1')).toBe("'+1");
    expect(escapeCsvText('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('formatCsvDecimal deberia usar seis decimales y coma', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(formatCsvDecimal(2.3)).toBe('2,300000');
    expect(formatCsvDecimal(0)).toBe('0,000000');
  });
});
