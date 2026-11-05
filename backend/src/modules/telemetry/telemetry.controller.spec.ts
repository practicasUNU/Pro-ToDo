import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { TelemetryPdfRenderer } from '@modules/telemetry/reports/telemetry-pdf.renderer';
import {
  CSV_FILENAME,
  PDF_FILENAME,
  TelemetryController,
} from '@modules/telemetry/telemetry.controller';
import { TelemetryQueryService } from '@modules/telemetry/telemetry-query.service';
import { UserRole } from '@modules/users/enums/user-role.enum';

import type { INestApplication } from '@nestjs/common';
import type { Response } from 'superagent';
import type { App } from 'supertest/types';
import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';

const EDITOR_USER: AuthenticatedUser = {
  id: 'b27d9e10-4c3f-4a8b-9f21-6d5e4c3b2a19',
  email: 'editor@unuware.com',
  role: UserRole.EDITOR,
};

const SUMMARY = {
  range: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-23T00:00:00.000Z' },
  totalTokens: 1_600,
  totalCostUsd: 2.3,
  aiInvocations: 3,
  estimatedInvocations: 1,
  executionsTotal: 4,
  executionsSucceeded: 3,
  successRate: 0.75,
};

/** Lee el cuerpo binario de una descarga como Buffer. */
const binaryParser = (
  response: Response,
  callback: (error: Error | null, body: Buffer) => void,
): void => {
  // En Node, la respuesta de superagent ES el flujo HTTP entrante: sus tipos
  // solo describen la vista ya parseada, de ahi la conversion.
  const stream = response as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => callback(null, Buffer.concat(chunks)));
};

describe('TelemetryController', () => {
  let app: INestApplication;
  let currentUser: AuthenticatedUser | undefined;
  const queryService = {
    getSummary: jest.fn().mockResolvedValue(SUMMARY),
    getBreakdownByModel: jest.fn().mockResolvedValue([]),
    getHistory: jest
      .fn()
      .mockResolvedValue({ items: [], total: 0, limit: 25, offset: 0 }),
    getExportRows: jest.fn().mockResolvedValue({
      range: {
        from: new Date('2026-10-01T00:00:00.000Z'),
        to: new Date('2026-10-23T00:00:00.000Z'),
      },
      items: [],
      truncated: false,
    }),
  };
  const pdfRenderer = {
    render: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.7 fake')),
  };

  beforeAll(async () => {
    // 1. Arrange 📐: RolesGuard autentico, JwtAuthGuard sustituido.
    const moduleRef = await Test.createTestingModule({
      controllers: [TelemetryController],
      providers: [
        { provide: TelemetryQueryService, useValue: queryService },
        { provide: TelemetryPdfRenderer, useValue: pdfRenderer },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp: () => {
            getRequest: () => { user?: AuthenticatedUser };
          };
        }) => {
          context.switchToHttp().getRequest().user = currentUser;
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    currentUser = EDITOR_USER;
  });

  const httpServer = (): App => app.getHttpServer() as App;

  it('deberia permitir al EDITOR leer el resumen', async () => {
    // 2. Act ⚙️
    const response = await request(httpServer()).get(
      '/telemetry/summary?from=2026-10-01&to=2026-10-22',
    );

    // 3. Assert 🎯
    expect(response.status).toBe(200);
    expect(response.body).toEqual(SUMMARY);
    expect(queryService.getSummary).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-10-01', to: '2026-10-22' }),
    );
  });

  it('deberia rechazar con 400 una fecha que no es ISO 8601', async () => {
    // 2. Act ⚙️
    const response = await request(httpServer()).get(
      '/telemetry/summary?from=ayer',
    );

    // 3. Assert 🎯
    expect(response.status).toBe(400);
    expect(queryService.getSummary).not.toHaveBeenCalled();
  });

  it('deberia rechazar con 400 un limit por encima del techo en el historial', async () => {
    // 2. Act ⚙️
    const response = await request(httpServer()).get(
      '/telemetry/history?limit=1000',
    );

    // 3. Assert 🎯
    expect(response.status).toBe(400);
  });

  it('deberia descargar el CSV con sus cabeceras de adjunto', async () => {
    // 2. Act ⚙️
    const response = await request(httpServer())
      .get('/telemetry/export/csv')
      .buffer(true)
      .parse(binaryParser);

    // 3. Assert 🎯
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename=${CSV_FILENAME}`,
    );
    expect((response.body as Buffer).toString('utf8')).toContain('Fecha;Flujo');
  });

  it('deberia descargar el PDF firmado con el correo de quien lo pide', async () => {
    // 2. Act ⚙️
    const response = await request(httpServer())
      .get('/telemetry/export/pdf')
      .buffer(true)
      .parse(binaryParser);

    // 3. Assert 🎯
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename=${PDF_FILENAME}`,
    );
    expect(pdfRenderer.render).toHaveBeenCalledWith(
      expect.objectContaining({ requestedBy: EDITOR_USER.email }),
    );
  });

  it('deberia responder 403 a una sesion sin rol reconocido', async () => {
    // 1. Arrange 📐
    currentUser = { ...EDITOR_USER, role: 'INVITADO' as UserRole };

    // 2. Act ⚙️
    const response = await request(httpServer()).get('/telemetry/summary');

    // 3. Assert 🎯
    expect(response.status).toBe(403);
  });
});
