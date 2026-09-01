import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { UserRole } from '@modules/users/enums/user-role.enum';

import { AllowedIpsController } from './allowed-ips.controller';
import { AllowedIpsService } from './allowed-ips.service';

import type { AllowedIp } from './entities/allowed-ip.entity';
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

const EXISTING_ENTRY: AllowedIp = {
  id: 'c8a1f2d3-5b6e-4790-8c1d-2e3f4a5b6c7d',
  ipOrCidr: '192.168.1.0/24',
  description: 'VPN Corporativa Madrid',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('AllowedIpsController (RBAC, PROT-04.2)', () => {
  let app: INestApplication;
  let allowedIpsServiceMock: jest.Mocked<
    Pick<AllowedIpsService, 'findAll' | 'create' | 'update' | 'remove'>
  >;
  /** Identidad que el JwtAuthGuard doble inyecta en `req.user` en cada peticion. */
  let currentUser: AuthenticatedUser | undefined;

  beforeAll(async () => {
    // 1. Arrange: app real con el RolesGuard autentico y el JwtAuthGuard sustituido,
    // para aislar la autorizacion de la verificacion criptografica del token.
    allowedIpsServiceMock = {
      findAll: jest.fn().mockResolvedValue([EXISTING_ENTRY]),
      create: jest.fn().mockResolvedValue(EXISTING_ENTRY),
      update: jest.fn().mockResolvedValue(EXISTING_ENTRY),
      remove: jest.fn().mockResolvedValue(EXISTING_ENTRY),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [AllowedIpsController],
      providers: [
        { provide: AllowedIpsService, useValue: allowedIpsServiceMock },
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
  });

  const httpServer = (): App => app.getHttpServer() as App;

  describe('cuando el solicitante tiene rol EDITOR', () => {
    beforeEach(() => {
      currentUser = EDITOR_USER;
    });

    it('deberia responder 403 en GET /allowed-ips y no alcanzar el servicio', async () => {
      // 2. Act
      const response = await request(httpServer()).get('/allowed-ips');

      // 3. Assert
      expect(response.status).toBe(403);
      expect(allowedIpsServiceMock.findAll).not.toHaveBeenCalled();
    });

    it('deberia responder 403 en POST /allowed-ips', async () => {
      // 2. Act
      const response = await request(httpServer())
        .post('/allowed-ips')
        .send({ ipOrCidr: '10.0.0.0/8', description: 'Red interna' });

      // 3. Assert
      expect(response.status).toBe(403);
      expect(allowedIpsServiceMock.create).not.toHaveBeenCalled();
    });

    it('deberia responder 403 en DELETE /allowed-ips/:id', async () => {
      // 2. Act
      const response = await request(httpServer()).delete(
        `/allowed-ips/${EXISTING_ENTRY.id}`,
      );

      // 3. Assert
      expect(response.status).toBe(403);
      expect(allowedIpsServiceMock.remove).not.toHaveBeenCalled();
    });
  });

  describe('cuando el solicitante tiene rol ADMIN', () => {
    beforeEach(() => {
      currentUser = ADMIN_USER;
    });

    it('deberia listar las IPs autorizadas en GET /allowed-ips', async () => {
      // 2. Act
      const response = await request(httpServer()).get('/allowed-ips');

      // 3. Assert
      expect(response.status).toBe(200);
      expect(allowedIpsServiceMock.findAll).toHaveBeenCalledTimes(1);
    });

    it('deberia crear una IP con 201 en POST /allowed-ips', async () => {
      // 1. Arrange
      const payload = { ipOrCidr: '10.0.0.0/8', description: 'Red interna' };

      // 2. Act
      const response = await request(httpServer())
        .post('/allowed-ips')
        .send(payload);

      // 3. Assert
      expect(response.status).toBe(201);
      expect(allowedIpsServiceMock.create).toHaveBeenCalledWith(payload);
    });

    it('deberia rechazar con 400 un ipOrCidr con formato invalido', async () => {
      // 2. Act
      const response = await request(httpServer())
        .post('/allowed-ips')
        .send({ ipOrCidr: 'no-es-una-ip', description: 'Invalida' });

      // 3. Assert
      expect(response.status).toBe(400);
      expect(allowedIpsServiceMock.create).not.toHaveBeenCalled();
    });

    it('deberia actualizar una IP en PATCH /allowed-ips/:id', async () => {
      // 2. Act
      const response = await request(httpServer())
        .patch(`/allowed-ips/${EXISTING_ENTRY.id}`)
        .send({ description: 'Descripcion nueva' });

      // 3. Assert
      expect(response.status).toBe(200);
      expect(allowedIpsServiceMock.update).toHaveBeenCalledWith(
        EXISTING_ENTRY.id,
        { description: 'Descripcion nueva' },
      );
    });

    it('deberia eliminar una IP en DELETE /allowed-ips/:id', async () => {
      // 2. Act
      const response = await request(httpServer()).delete(
        `/allowed-ips/${EXISTING_ENTRY.id}`,
      );

      // 3. Assert
      expect(response.status).toBe(200);
      expect(allowedIpsServiceMock.remove).toHaveBeenCalledWith(
        EXISTING_ENTRY.id,
      );
    });

    it('deberia rechazar con 400 un identificador que no es UUID (ParseUUIDPipe)', async () => {
      // 2. Act
      const response = await request(httpServer()).delete(
        '/allowed-ips/no-es-un-uuid',
      );

      // 3. Assert
      expect(response.status).toBe(400);
      expect(allowedIpsServiceMock.remove).not.toHaveBeenCalled();
    });
  });
});
