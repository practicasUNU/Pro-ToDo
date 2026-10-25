import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';

import { OTP_THROTTLER_NAME } from '@common/constants/throttler.constants';
import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import { PipelineValidatorService } from '@core/fsm/services/pipeline-validator.service';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { UserRole } from '@modules/users/enums/user-role.enum';

import { NodeSandboxController } from './node-sandbox.controller';
import { NodeSandboxService } from './node-sandbox.service';

import type { INestApplication } from '@nestjs/common';
import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';
import type { App } from 'supertest/types';

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

const body = (nodeType: NodeType): Record<string, unknown> => ({
  nodeType,
  params: {},
  upstreamContext: { parsed_email: { clean_title: 'Convocatoria 2026' } },
});

/**
 * RBAC POR TIPO DE NODO, con el `RolesGuard` y el servicio REALES: la regla
 * vive en el servicio porque depende del cuerpo, y doblarlo aqui no probaria
 * nada. Lo unico doblado es la estrategia (sin red) y el validador de params.
 */
describe('NodeSandboxController (POST /nodes/sandbox/run)', () => {
  let app: INestApplication;
  let currentUser: AuthenticatedUser | undefined;
  const execute = jest.fn();

  beforeAll(async () => {
    // 1. Arrange 📐
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          { name: OTP_THROTTLER_NAME, ttl: 60_000, limit: 1_000 },
        ]),
      ],
      controllers: [NodeSandboxController],
      providers: [
        NodeSandboxService,
        {
          provide: NodeStrategyFactory,
          useValue: { getStrategy: () => ({ execute }) },
        },
        {
          provide: PipelineValidatorService,
          useValue: {
            validateStandaloneParams: jest.fn().mockResolvedValue([]),
          },
        },
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
    execute.mockReset().mockResolvedValue({
      success: true,
      data: { statusCode: 200 },
    });
  });

  const httpServer = (): App => app.getHttpServer() as App;

  describe('1. EDITOR', () => {
    beforeEach(() => {
      currentUser = EDITOR_USER;
    });

    it.each([NodeType.PROCESADOR_IA, NodeType.PROCESADOR_OCR])(
      '1.1 deberia recibir 403 al probar %s, sin ejecutar nada',
      async (nodeType) => {
        // 2. Act ⚙️
        const response = await request(httpServer())
          .post('/nodes/sandbox/run')
          .send(body(nodeType));

        // 3. Assert 🎯: ni un token facturado.
        expect(response.status).toBe(403);
        expect(execute).not.toHaveBeenCalled();
      },
    );

    it('1.2 deberia poder probar el destino HTTP generico', async () => {
      // 2. Act ⚙️
      const response = await request(httpServer())
        .post('/nodes/sandbox/run')
        .send(body(NodeType.DESTINO_HTTP_GENERICO));

      // 3. Assert 🎯
      expect(response.status).toBe(200);
      expect(response.body).toEqual(
        expect.objectContaining({ success: true, data: { statusCode: 200 } }),
      );
    });
  });

  describe('2. ADMIN', () => {
    beforeEach(() => {
      currentUser = ADMIN_USER;
    });

    it.each([
      NodeType.PROCESADOR_IA,
      NodeType.PROCESADOR_OCR,
      NodeType.DESTINO_HTTP_GENERICO,
    ])('2.1 deberia poder probar %s', async (nodeType) => {
      // 2. Act ⚙️
      const response = await request(httpServer())
        .post('/nodes/sandbox/run')
        .send(body(nodeType));

      // 3. Assert 🎯
      expect(response.status).toBe(200);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('2.2 deberia rechazar con 400 un tipo que no se prueba aislado', async () => {
      // 2. Act ⚙️: un disparador abriria el buzon real.
      const response = await request(httpServer())
        .post('/nodes/sandbox/run')
        .send(body(NodeType.TRIGGER_IMAP));

      // 3. Assert 🎯
      expect(response.status).toBe(400);
      expect(execute).not.toHaveBeenCalled();
    });

    it('2.3 deberia rechazar con 400 un contexto simulado mal formado', async () => {
      // 2. Act ⚙️: un namespace que no es un objeto.
      const response = await request(httpServer())
        .post('/nodes/sandbox/run')
        .send({
          nodeType: NodeType.DESTINO_HTTP_GENERICO,
          params: {},
          upstreamContext: { parsed_email: 'texto suelto' },
        });

      // 3. Assert 🎯
      expect(response.status).toBe(400);
      expect(execute).not.toHaveBeenCalled();
    });
  });
});
