import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import {
  AUDIT_CSV_FILENAME,
  AUDIT_PDF_FILENAME,
  AuditController,
} from '@modules/audit/audit.controller';
import { AuditPdfRenderer } from '@modules/audit/reports/audit-pdf.renderer';
import { AuditLoggerService } from '@modules/audit/services/audit-logger.service';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { UserRole } from '@modules/users/enums/user-role.enum';

import type { INestApplication } from '@nestjs/common';
import type { Response } from 'superagent';
import type { App } from 'supertest/types';
import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';

const ADMIN_USER: AuthenticatedUser = {
  id: '3f1c2b64-8a5e-4c2f-9d3a-7b6e5f4c1a20',
  email: 'admin@unuware.com',
  role: UserRole.ADMIN,
};

const EDITOR_USER: AuthenticatedUser = {
  id: 'b27d9e10-4c3f-4a8b-9f21-6d5e4c3b2a19',
  email: 'editor@unuware.com',
  role: UserRole.EDITOR,
};

const PAGE = { items: [], total: 0, limit: 25, offset: 0 };

/** Lee el cuerpo binario de una descarga como Buffer. */
const binaryParser = (
  response: Response,
  callback: (error: Error | null, body: Buffer) => void,
): void => {
  const stream = response as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => callback(null, Buffer.concat(chunks)));
};

describe('AuditController', () => {
  let app: INestApplication;
  let currentUser: AuthenticatedUser | undefined;
  const auditLogger = {
    findPage: jest.fn().mockResolvedValue(PAGE),
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
      controllers: [AuditController],
      providers: [
        { provide: AuditLoggerService, useValue: auditLogger },
        { provide: AuditPdfRenderer, useValue: pdfRenderer },
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
    currentUser = ADMIN_USER;
  });

  const httpServer = (): App => app.getHttpServer() as App;

  it('deberia devolver al ADMIN la pagina de eventos con los filtros validados', async () => {
    // 2. Act ⚙️
    const response = await request(httpServer()).get(
      `/audit/events?userId=${EDITOR_USER.id}&action=ROLE_CHANGE&affectedTable=usuarios&limit=10`,
    );

    // 3. Assert 🎯
    expect(response.status).toBe(200);
    expect(response.body).toEqual(PAGE);
    expect(auditLogger.findPage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: EDITOR_USER.id,
        action: 'ROLE_CHANGE',
        affectedTable: 'usuarios',
        limit: 10,
      }),
    );
  });

  it('deberia responder 403 al EDITOR', async () => {
    // 1. Arrange 📐
    currentUser = EDITOR_USER;

    // 2. Act ⚙️
    const response = await request(httpServer()).get('/audit/events');

    // 3. Assert 🎯
    expect(response.status).toBe(403);
    expect(auditLogger.findPage).not.toHaveBeenCalled();
  });

  it('deberia rechazar con 400 una tabla que no se audita', async () => {
    // 2. Act ⚙️
    const response = await request(httpServer()).get(
      '/audit/events?affectedTable=tokens_sesion',
    );

    // 3. Assert 🎯
    expect(response.status).toBe(400);
  });

  it('deberia descargar el CSV con sus cabeceras de adjunto', async () => {
    // 2. Act ⚙️
    const response = await request(httpServer())
      .get('/audit/reports/export?format=csv')
      .buffer(true)
      .parse(binaryParser);

    // 3. Assert 🎯
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename=${AUDIT_CSV_FILENAME}`,
    );
    expect((response.body as Buffer).toString('utf8')).toContain(
      'Fecha;Usuario;Acción',
    );
  });

  it('deberia descargar el PDF firmado con el correo de quien lo pide', async () => {
    // 2. Act ⚙️
    const response = await request(httpServer())
      .get('/audit/reports/export?format=pdf&action=LOGIN_FAILED')
      .buffer(true)
      .parse(binaryParser);

    // 3. Assert 🎯
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename=${AUDIT_PDF_FILENAME}`,
    );
    expect(pdfRenderer.render).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedBy: ADMIN_USER.email,
        filters: expect.objectContaining({ action: 'LOGIN_FAILED' }) as unknown,
      }),
    );
  });

  it('deberia rechazar con 400 un formato de exportacion desconocido', async () => {
    // 2. Act ⚙️
    const response = await request(httpServer()).get(
      '/audit/reports/export?format=xlsx',
    );

    // 3. Assert 🎯
    expect(response.status).toBe(400);
    expect(auditLogger.getExportRows).not.toHaveBeenCalled();
  });
});
