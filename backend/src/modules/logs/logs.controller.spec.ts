import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { LogsController } from '@modules/logs/logs.controller';
import { ExecutionLogReaderService } from '@modules/logs/services/execution-log-reader.service';
import { UserRole } from '@modules/users/enums/user-role.enum';

import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';
import type { ExecutionLogResponseDto } from '@modules/logs/dto/execution-log-response.dto';

const EXECUTION_ID = '735dc678-1111-4111-8111-111111111111';

const EDITOR_USER: AuthenticatedUser = {
  id: 'b27d9e10-4c3f-4a8b-9f21-6d5e4c3b2a19',
  email: 'editor@unuware.com',
  role: UserRole.EDITOR,
};

const EXECUTION_LOG: ExecutionLogResponseDto = {
  executionId: EXECUTION_ID,
  timestamp: '2026-10-22T08:00:05.000Z',
  level: 'GRAVE',
  stackTrace:
    'AnthropicProviderException: 529\n    at toPayload (src/x.ts:1:1)',
  rawLog: '{"executionId":"735dc678-1111-4111-8111-111111111111"}',
  truncated: false,
};

describe('LogsController (GET /logs/execution/:executionId)', () => {
  let app: INestApplication;
  let currentUser: AuthenticatedUser | undefined;
  const logReader = {
    readExecutionLog: jest.fn().mockResolvedValue(EXECUTION_LOG),
  };

  beforeAll(async () => {
    // 1. Arrange 📐: RolesGuard autentico, JwtAuthGuard sustituido para
    //    aislar la autorizacion de la verificacion del token.
    const moduleRef = await Test.createTestingModule({
      controllers: [LogsController],
      providers: [{ provide: ExecutionLogReaderService, useValue: logReader }],
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

  it('deberia devolver la traza de la ejecucion a un EDITOR', async () => {
    // 2. Act ⚙️
    const response = await request(httpServer()).get(
      `/logs/execution/${EXECUTION_ID}`,
    );

    // 3. Assert 🎯
    expect(response.status).toBe(200);
    expect(response.body).toEqual(EXECUTION_LOG);
    expect(logReader.readExecutionLog).toHaveBeenCalledWith(EXECUTION_ID);
  });

  it('deberia permitirlo tambien a un ADMIN', async () => {
    // 1. Arrange 📐
    currentUser = { ...EDITOR_USER, role: UserRole.ADMIN };

    // 2. Act ⚙️
    const response = await request(httpServer()).get(
      `/logs/execution/${EXECUTION_ID}`,
    );

    // 3. Assert 🎯
    expect(response.status).toBe(200);
  });

  it('deberia responder 403 a un rol no autorizado sin leer nada', async () => {
    // 1. Arrange 📐
    currentUser = { ...EDITOR_USER, role: 'INVITADO' as UserRole };

    // 2. Act ⚙️
    const response = await request(httpServer()).get(
      `/logs/execution/${EXECUTION_ID}`,
    );

    // 3. Assert 🎯
    expect(response.status).toBe(403);
    expect(logReader.readExecutionLog).not.toHaveBeenCalled();
  });

  it('deberia responder 403 sin usuario autenticado en la peticion', async () => {
    // 1. Arrange 📐
    currentUser = undefined;

    // 2. Act ⚙️
    const response = await request(httpServer()).get(
      `/logs/execution/${EXECUTION_ID}`,
    );

    // 3. Assert 🎯
    expect(response.status).toBe(403);
    expect(logReader.readExecutionLog).not.toHaveBeenCalled();
  });

  it('deberia rechazar con 400 un identificador que no es UUID', async () => {
    // 2. Act ⚙️: nunca llega al lector, ni siquiera con algo que parezca ruta.
    const response = await request(httpServer()).get(
      '/logs/execution/..%2F..%2Fetc%2Fpasswd',
    );

    // 3. Assert 🎯
    expect(response.status).toBe(400);
    expect(logReader.readExecutionLog).not.toHaveBeenCalled();
  });
});
