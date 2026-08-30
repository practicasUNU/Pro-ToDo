import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';

import { UserRole } from './enums/user-role.enum';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

import type { INestApplication } from '@nestjs/common';
import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';
import type { App } from 'supertest/types';
import type { User } from './entities/user.entity';

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

/** Secreto TOTP cargado a proposito: la respuesta jamas debe contenerlo. */
const LEAKY_OTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

const EXISTING_USER: User = {
  id: 'c8a1f2d3-5b6e-4790-8c1d-2e3f4a5b6c7d',
  email: 'usuario@unuware.com',
  role: UserRole.EDITOR,
  otpSecret: LEAKY_OTP_SECRET,
  isActive: true,
};

/** Lo que el cliente debe ver: la entidad menos `otpSecret`. */
const EXISTING_USER_RESPONSE = {
  id: EXISTING_USER.id,
  email: EXISTING_USER.email,
  role: EXISTING_USER.role,
  isActive: EXISTING_USER.isActive,
};

describe('UsersController (RBAC, PROT-04.2)', () => {
  let app: INestApplication;
  let usersServiceMock: jest.Mocked<
    Pick<UsersService, 'findAll' | 'findOne' | 'create' | 'update' | 'remove'>
  >;
  /** Identidad que el JwtAuthGuard doble inyecta en `req.user` en cada peticion. */
  let currentUser: AuthenticatedUser | undefined;

  beforeAll(async () => {
    // 1. Arrange: app real con el RolesGuard autentico y el JwtAuthGuard sustituido,
    // para aislar la autorizacion de la verificacion criptografica del token.
    usersServiceMock = {
      findAll: jest.fn().mockResolvedValue([EXISTING_USER]),
      findOne: jest.fn().mockResolvedValue(EXISTING_USER),
      create: jest.fn().mockResolvedValue(EXISTING_USER),
      update: jest.fn().mockResolvedValue(EXISTING_USER),
      remove: jest
        .fn()
        .mockResolvedValue({ ...EXISTING_USER, isActive: false }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: usersServiceMock }],
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
  });

  /** Servidor HTTP tipado para supertest. */
  const httpServer = (): App => app.getHttpServer() as App;

  describe('cuando el solicitante tiene rol EDITOR', () => {
    beforeEach(() => {
      currentUser = EDITOR_USER;
    });

    it('deberia responder 403 en GET /users y no alcanzar el servicio', async () => {
      // 2. Act
      const response = await request(httpServer()).get('/users');

      // 3. Assert
      expect(response.status).toBe(403);
      expect(usersServiceMock.findAll).not.toHaveBeenCalled();
    });

    it('deberia responder 403 en GET /users/:id', async () => {
      // 2. Act
      const response = await request(httpServer()).get(
        `/users/${EXISTING_USER.id}`,
      );

      // 3. Assert
      expect(response.status).toBe(403);
      expect(usersServiceMock.findOne).not.toHaveBeenCalled();
    });

    it('deberia responder 403 en POST /users', async () => {
      // 2. Act
      const response = await request(httpServer())
        .post('/users')
        .send({ email: 'nuevo@unuware.com', role: UserRole.EDITOR });

      // 3. Assert
      expect(response.status).toBe(403);
      expect(usersServiceMock.create).not.toHaveBeenCalled();
    });

    it('deberia responder 403 en PATCH /users/:id', async () => {
      // 2. Act
      const response = await request(httpServer())
        .patch(`/users/${EXISTING_USER.id}`)
        .send({ role: UserRole.ADMIN });

      // 3. Assert
      expect(response.status).toBe(403);
      expect(usersServiceMock.update).not.toHaveBeenCalled();
    });

    it('deberia responder 403 en DELETE /users/:id', async () => {
      // 2. Act
      const response = await request(httpServer()).delete(
        `/users/${EXISTING_USER.id}`,
      );

      // 3. Assert
      expect(response.status).toBe(403);
      expect(usersServiceMock.remove).not.toHaveBeenCalled();
    });
  });

  describe('cuando el solicitante tiene rol ADMIN', () => {
    beforeEach(() => {
      currentUser = ADMIN_USER;
    });

    it('deberia listar los usuarios en GET /users', async () => {
      // 2. Act
      const response = await request(httpServer()).get('/users');

      // 3. Assert
      expect(response.status).toBe(200);
      expect(response.body).toEqual([EXISTING_USER_RESPONSE]);
      expect(usersServiceMock.findAll).toHaveBeenCalledTimes(1);
    });

    it('deberia delegar en el servicio en GET /users/:id', async () => {
      // 2. Act
      const response = await request(httpServer()).get(
        `/users/${EXISTING_USER.id}`,
      );

      // 3. Assert
      expect(response.status).toBe(200);
      expect(usersServiceMock.findOne).toHaveBeenCalledWith(EXISTING_USER.id);
    });

    it('deberia crear un usuario con 201 en POST /users', async () => {
      // 1. Arrange
      const payload = { email: 'nuevo@unuware.com', role: UserRole.EDITOR };

      // 2. Act
      const response = await request(httpServer()).post('/users').send(payload);

      // 3. Assert
      expect(response.status).toBe(201);
      expect(usersServiceMock.create).toHaveBeenCalledWith(payload);
    });

    it('deberia desactivar un usuario en DELETE /users/:id (borrado logico)', async () => {
      // 2. Act
      const response = await request(httpServer()).delete(
        `/users/${EXISTING_USER.id}`,
      );

      // 3. Assert
      expect(response.status).toBe(200);
      expect((response.body as User).isActive).toBe(false);
      expect(usersServiceMock.remove).toHaveBeenCalledWith(EXISTING_USER.id);
    });

    it('deberia rechazar con 400 un identificador que no es UUID (ParseUUIDPipe)', async () => {
      // 2. Act
      const response = await request(httpServer()).get('/users/no-es-un-uuid');

      // 3. Assert
      expect(response.status).toBe(400);
      expect(usersServiceMock.findOne).not.toHaveBeenCalled();
    });

    it('deberia rechazar con 400 un payload con correo invalido (CreateUserDto)', async () => {
      // 2. Act
      const response = await request(httpServer())
        .post('/users')
        .send({ email: 'no-es-un-correo', role: UserRole.EDITOR });

      // 3. Assert
      expect(response.status).toBe(400);
      expect(usersServiceMock.create).not.toHaveBeenCalled();
    });

    it('deberia responder 403 si el ADMIN intenta modificar su propio usuario (MOD-01)', async () => {
      // 2. Act
      const response = await request(httpServer())
        .patch(`/users/${ADMIN_USER.id}`)
        .send({ role: UserRole.EDITOR });

      // 3. Assert
      expect(response.status).toBe(403);
      expect(usersServiceMock.update).not.toHaveBeenCalled();
    });

    it('deberia responder 403 si el ADMIN intenta eliminar su propio usuario (MOD-01)', async () => {
      // 2. Act
      const response = await request(httpServer()).delete(
        `/users/${ADMIN_USER.id}`,
      );

      // 3. Assert
      expect(response.status).toBe(403);
      expect(usersServiceMock.remove).not.toHaveBeenCalled();
    });
  });

  describe('cuando la peticion no trae identidad', () => {
    beforeEach(() => {
      currentUser = undefined;
    });

    it('deberia responder 403 en GET /users', async () => {
      // 2. Act
      const response = await request(httpServer()).get('/users');

      // 3. Assert
      expect(response.status).toBe(403);
      expect(usersServiceMock.findAll).not.toHaveBeenCalled();
    });
  });
  describe('serializacion de la respuesta (UserResponseDto)', () => {
    beforeEach(() => {
      currentUser = ADMIN_USER;
    });

    it('NUNCA deberia exponer otpSecret aunque el servicio lo devuelva cargado', async () => {
      // 2. Act
      const response = await request(httpServer()).get('/users');

      // 3. Assert
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain(LEAKY_OTP_SECRET);
      expect(response.body).toEqual([EXISTING_USER_RESPONSE]);
    });

    it('deberia filtrar otpSecret en todos los verbos, no solo en el listado', async () => {
      // 2. Act: en serie, no en paralelo -- varias peticiones simultaneas contra
      // la misma instancia de supertest provocan ECONNRESET
      const responses = [
        await request(httpServer()).get(`/users/${EXISTING_USER.id}`),
        await request(httpServer())
          .post('/users')
          .send({ email: 'nuevo@unuware.com', role: UserRole.EDITOR }),
        await request(httpServer())
          .patch(`/users/${EXISTING_USER.id}`)
          .send({ role: UserRole.ADMIN }),
        await request(httpServer()).delete(`/users/${EXISTING_USER.id}`),
      ];

      // 3. Assert
      for (const response of responses) {
        expect(JSON.stringify(response.body)).not.toContain(LEAKY_OTP_SECRET);
        expect(response.body).not.toHaveProperty('otpSecret');
      }
    });
  });
});
