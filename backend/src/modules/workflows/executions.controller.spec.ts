import { Test } from '@nestjs/testing';
import request from 'supertest';

import { createGlobalValidationPipe } from '@common/pipes/global-validation.pipe';
import { ExecutionState } from '@core/fsm/types/fsm.enums';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { UserRole } from '@modules/users/enums/user-role.enum';

import { CSV_FILENAME, ExecutionsController } from './executions.controller';
import { ExecutionsService } from './executions.service';

import type { INestApplication } from '@nestjs/common';
import type { Response } from 'superagent';
import type { App } from 'supertest/types';
import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';
import type { ExecutionExportRows } from './executions.service';

const FLOW_ID = 'b6c1f0d2-3e4a-4b5c-8d6e-7f8091a2b3c4';

const EDITOR_USER: AuthenticatedUser = {
  id: 'b27d9e10-4c3f-4a8b-9f21-6d5e4c3b2a19',
  email: 'editor@unuware.com',
  role: UserRole.EDITOR,
};

const EXPORT_ROWS: ExecutionExportRows = {
  rows: [
    {
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
    },
  ],
  truncated: false,
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

describe('ExecutionsController (exportacion CSV)', () => {
  let app: INestApplication;
  let currentUser: AuthenticatedUser | undefined;
  const executionsService = {
    findAll: jest.fn(),
    findOne: jest.fn(),
    findAllForExport: jest.fn(),
  };

  beforeAll(async () => {
    // 1. Arrange 📐: RolesGuard autentico, JwtAuthGuard sustituido y el MISMO
    //    pipe global que `main.ts` (con `forbidNonWhitelisted`).
    const moduleRef = await Test.createTestingModule({
      controllers: [ExecutionsController],
      providers: [{ provide: ExecutionsService, useValue: executionsService }],
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
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    executionsService.findAllForExport.mockResolvedValue(EXPORT_ROWS);
    currentUser = EDITOR_USER;
  });

  const httpServer = (): App => app.getHttpServer() as App;

  it('deberia descargar el CSV con sus cabeceras de adjunto', async () => {
    // 2. Act ⚙️
    const response = await request(httpServer())
      .get('/executions/export/csv')
      .buffer(true)
      .parse(binaryParser);

    // 3. Assert 🎯: la ruta se resuelve antes que `:id`, que la rechazaria
    //    con 400 por no ser un UUID.
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename=${CSV_FILENAME}`,
    );
    expect((response.body as Buffer).toString('utf8')).toContain(
      'Ejecución;Flujo;ID flujo;Estado',
    );
    expect((response.body as Buffer).toString('utf8')).toContain(';Notiweb;');
    expect(executionsService.findOne).not.toHaveBeenCalled();
  });

  it('deberia trasladar los filtros y el orden al servicio', async () => {
    // 2. Act ⚙️
    const response = await request(httpServer())
      .get('/executions/export/csv')
      .query({
        flowId: FLOW_ID,
        state: ExecutionState.PAUSADO,
        from: '2026-10-01',
        to: '2026-10-22',
        sortBy: 'startedAt',
        sortOrder: 'ASC',
      })
      .buffer(true)
      .parse(binaryParser);

    // 3. Assert 🎯
    expect(response.status).toBe(200);
    expect(executionsService.findAllForExport).toHaveBeenCalledWith({
      flowId: FLOW_ID,
      state: ExecutionState.PAUSADO,
      from: '2026-10-01',
      to: '2026-10-22',
      sortBy: 'startedAt',
      sortOrder: 'ASC',
    });
  });

  it('deberia rechazar con 400 una ventana de pagina: el informe no pagina', async () => {
    // 2. Act ⚙️
    const response = await request(httpServer()).get(
      '/executions/export/csv?limit=10&offset=20',
    );

    // 3. Assert 🎯
    expect(response.status).toBe(400);
    expect(executionsService.findAllForExport).not.toHaveBeenCalled();
  });

  it('deberia rechazar con 400 un estado inexistente', async () => {
    // 2. Act ⚙️
    const response = await request(httpServer()).get(
      '/executions/export/csv?state=BORRADO',
    );

    // 3. Assert 🎯
    expect(response.status).toBe(400);
    expect(executionsService.findAllForExport).not.toHaveBeenCalled();
  });

  it('deberia permitir la exportacion al ADMIN', async () => {
    // 1. Arrange 📐
    currentUser = { ...EDITOR_USER, role: UserRole.ADMIN };

    // 2. Act ⚙️
    const response = await request(httpServer())
      .get('/executions/export/csv')
      .buffer(true)
      .parse(binaryParser);

    // 3. Assert 🎯
    expect(response.status).toBe(200);
  });

  it('deberia responder 403 a una sesion sin rol reconocido', async () => {
    // 1. Arrange 📐
    currentUser = { ...EDITOR_USER, role: 'INVITADO' as UserRole };

    // 2. Act ⚙️
    const response = await request(httpServer()).get('/executions/export/csv');

    // 3. Assert 🎯
    expect(response.status).toBe(403);
    expect(executionsService.findAllForExport).not.toHaveBeenCalled();
  });
});
