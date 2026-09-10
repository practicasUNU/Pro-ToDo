import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { FsmController } from '@core/fsm/controllers/fsm.controller';
import { PipelineValidatorService } from '@core/fsm/services/pipeline-validator.service';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { UserRole } from '@modules/users/enums/user-role.enum';

import type { PipelineSchemaDto } from '@core/fsm/dto/pipeline-schema.dto';
import type { INestApplication } from '@nestjs/common';
import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';
import type { App } from 'supertest/types';

const EDITOR_USER: AuthenticatedUser = {
  id: 'b27d9e10-4c3f-4a8b-9f21-6d5e4c3b2a19',
  email: 'editor@unuware.com',
  role: UserRole.EDITOR,
};

/** Esquema minimo e integro, tal y como lo devolveria el validador. */
const VALID_SCHEMA = {
  flowId: 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  name: 'Notiweb - publicacion automatica',
  version: '1.0.0',
  entrypoint: 'trigger_imap',
  nodes: {
    trigger_imap: {
      nodeId: 'trigger_imap',
      nodeType: NodeType.TRIGGER_IMAP,
      outputNamespace: 'raw_email',
      nextStep: null,
      onErrorStep: null,
      params: {},
    },
  },
} as unknown as PipelineSchemaDto;

/** Excepcion con la forma EXACTA que arma `PipelineValidatorService`. */
const buildValidatorError = (): BadRequestException =>
  new BadRequestException({
    statusCode: 400,
    error: 'PIPELINE_SCHEMA_INVALIDO',
    message: 'El esquema del pipeline no supera la validacion.',
    issues: [
      {
        field: 'nodes.trigger_imap.params.mailbox',
        constraints: ['mailbox no puede estar vacio.'],
      },
      {
        field: 'version',
        constraints: [
          'version debe ser una cadena.',
          'version debe seguir el formato SemVer MAJOR.MINOR.PATCH.',
        ],
      },
    ],
  });

describe('FsmController (POST /fsm/validate-schema)', () => {
  let app: INestApplication;
  let validatorMock: jest.Mocked<Pick<PipelineValidatorService, 'validateSchema'>>;
  /** Identidad que el JwtAuthGuard doble inyecta en `req.user`. */
  let currentUser: AuthenticatedUser | undefined;

  beforeAll(async () => {
    // 1. Arrange: app real con el RolesGuard autentico y el JwtAuthGuard
    // sustituido, para aislar la autorizacion de la verificacion del token.
    validatorMock = {
      validateSchema: jest.fn().mockResolvedValue(VALID_SCHEMA),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [FsmController],
      providers: [
        { provide: PipelineValidatorService, useValue: validatorMock },
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
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    currentUser = EDITOR_USER;
    validatorMock.validateSchema.mockResolvedValue(VALID_SCHEMA);
  });

  const httpServer = (): App => app.getHttpServer() as App;

  describe('1. Esquema integro', () => {
    it('1.1 deberia responder 200 con { success: true, schema }', async () => {
      // 2. Act
      const response = await request(httpServer())
        .post('/fsm/validate-schema')
        .send(VALID_SCHEMA);

      // 3. Assert: el 200 es simetrico al 400; el cliente conmuta siempre sobre
      // la misma clave `success`.
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, schema: VALID_SCHEMA });
    });

    it('1.2 deberia pasar el cuerpo al validador SIN tocarlo', async () => {
      // 1. Arrange: una propiedad que el DTO no declara.
      const withExtra = { ...VALID_SCHEMA, nextStepp: 'typo' };

      // 2. Act
      await request(httpServer()).post('/fsm/validate-schema').send(withExtra);

      // 3. Assert: el ValidationPipe global no debe filtrarla, o el validador no
      // podria rechazarla con `forbidNonWhitelisted`.
      expect(validatorMock.validateSchema).toHaveBeenCalledWith(
        expect.objectContaining({ nextStepp: 'typo' }),
      );
    });
  });

  describe('2. Contrato de error', () => {
    it('2.1 deberia responder 400 con { success: false, issues: [{path, message}] }', async () => {
      // 1. Arrange
      validatorMock.validateSchema.mockRejectedValue(buildValidatorError());

      // 2. Act
      const response = await request(httpServer())
        .post('/fsm/validate-schema')
        .send({ roto: true });

      // 3. Assert
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        issues: [
          {
            path: 'nodes.trigger_imap.params.mailbox',
            message: 'mailbox no puede estar vacio.',
          },
          { path: 'version', message: 'version debe ser una cadena.' },
          {
            path: 'version',
            message: 'version debe seguir el formato SemVer MAJOR.MINOR.PATCH.',
          },
        ],
      });
    });

    it('2.2 NO deberia filtrar la forma interna del validador', async () => {
      // 1. Arrange
      validatorMock.validateSchema.mockRejectedValue(buildValidatorError());

      // 2. Act
      const response = await request(httpServer())
        .post('/fsm/validate-schema')
        .send({ roto: true });

      // 3. Assert: `field`, `constraints` y el codigo interno son la forma que
      // conservan los DEMAS endpoints; este endpoint publica la traducida.
      const body = JSON.stringify(response.body);

      expect(body).not.toContain('constraints');
      expect(body).not.toContain('PIPELINE_SCHEMA_INVALIDO');
      expect(body).not.toContain('"field"');
    });

    it('2.3 deberia propagar un error ajeno al validador sin traducirlo', async () => {
      // 1. Arrange
      validatorMock.validateSchema.mockRejectedValue(
        new Error('PostgreSQL no responde'),
      );

      // 2. Act
      const response = await request(httpServer())
        .post('/fsm/validate-schema')
        .send(VALID_SCHEMA);

      // 3. Assert: un fallo de infraestructura no es un esquema invalido, y
      // devolverlo como 400 con `issues: []` mentiria sobre la causa.
      expect(response.status).toBe(500);
    });
  });

  describe('3. Autorizacion (PROT-04.2)', () => {
    it('3.1 NO deberia restringir por rol: basta con estar autenticado', async () => {
      // 1. Arrange: el RolesGuard va REAL y la ruta no declara `@Roles(...)`,
      // asi que el guard deja pasar por ausencia de metadata. Quien corta el
      // acceso aqui es `JwtAuthGuard`, doblado en este harness.
      currentUser = undefined;

      // 2. Act
      const response = await request(httpServer())
        .post('/fsm/validate-schema')
        .send(VALID_SCHEMA);

      // 3. Assert: es la decision documentada en el TSDoc del controlador
      // —configurar y auditar flujos es competencia del EDITOR, no solo del
      // ADMIN—, y esta prueba existe para que anadir un `@Roles` mas restrictivo
      // sin querer se note aqui.
      expect(response.status).toBe(200);
    });

    it('3.2 deberia permitir validar al rol EDITOR', async () => {
      // 1. Arrange: configurar y auditar flujos es competencia del EDITOR.
      currentUser = EDITOR_USER;

      // 2. Act
      const response = await request(httpServer())
        .post('/fsm/validate-schema')
        .send(VALID_SCHEMA);

      // 3. Assert
      expect(response.status).toBe(200);
    });
  });
});
