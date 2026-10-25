import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { UserRole } from '@modules/users/enums/user-role.enum';

import { CredentialsController } from './credentials.controller';
import { CredentialsService } from './credentials.service';
import { CredentialAuthType } from './enums/credential-auth-type.enum';

import type { INestApplication } from '@nestjs/common';
import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';
import type { App } from 'supertest/types';
import type { Credential } from './entities/credential.entity';

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

/** Columnas criptograficas cargadas A PROPOSITO: nunca deben salir. */
const LEAKY_CIPHERTEXT = 'Q0lGUkFETy1RVUUtTk8tREVCRS1TQUxJUg==';

const STORED: Credential = {
  id: '0b9a2c47-5d1e-4f3a-8c6b-2e7d9f1a4b30',
  name: 'API de becas',
  authType: CredentialAuthType.BEARER_TOKEN,
  encryptedData: LEAKY_CIPHERTEXT,
  iv: 'SVYtRklMVFJBRE8=',
  authTag: 'VEFHLUZJTFRSQURB',
  createdAt: new Date('2026-10-24T08:00:00.000Z'),
  updatedAt: new Date('2026-10-24T08:00:00.000Z'),
};

describe('CredentialsController (RBAC y lista blanca)', () => {
  let app: INestApplication;
  let serviceMock: jest.Mocked<
    Pick<
      CredentialsService,
      'findAll' | 'findOptions' | 'findOne' | 'create' | 'update' | 'remove'
    >
  >;
  let currentUser: AuthenticatedUser | undefined;

  beforeAll(async () => {
    // 1. Arrange 📐: RolesGuard autentico y JwtAuthGuard doble, para aislar
    //    la autorizacion de la verificacion criptografica del token.
    serviceMock = {
      findAll: jest.fn().mockResolvedValue([STORED]),
      findOptions: jest.fn().mockResolvedValue([STORED]),
      findOne: jest.fn().mockResolvedValue(STORED),
      create: jest.fn().mockResolvedValue(STORED),
      update: jest.fn().mockResolvedValue(STORED),
      remove: jest.fn().mockResolvedValue(STORED),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [CredentialsController],
      providers: [{ provide: CredentialsService, useValue: serviceMock }],
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

  describe('1. EDITOR', () => {
    beforeEach(() => {
      currentUser = EDITOR_USER;
    });

    it.each([
      ['get', '/credentials'],
      ['get', `/credentials/${STORED.id}`],
      ['post', '/credentials'],
      ['patch', `/credentials/${STORED.id}`],
      ['delete', `/credentials/${STORED.id}`],
    ] as const)(
      '1.1 deberia responder 403 en %s %s sin alcanzar el servicio',
      async (method, path) => {
        // 2. Act ⚙️
        const response = await request(httpServer())[method](path).send({});

        // 3. Assert 🎯
        expect(response.status).toBe(403);
        expect(serviceMock.findAll).not.toHaveBeenCalled();
        expect(serviceMock.create).not.toHaveBeenCalled();
        expect(serviceMock.update).not.toHaveBeenCalled();
        expect(serviceMock.remove).not.toHaveBeenCalled();
      },
    );

    it('1.2 deberia ver SOLO id, nombre y tipo en /credentials/options', async () => {
      // 2. Act ⚙️
      const response = await request(httpServer()).get(
        '/credentials/options?authType=BEARER_TOKEN',
      );

      // 3. Assert 🎯
      expect(response.status).toBe(200);
      expect(response.body).toEqual([
        { id: STORED.id, name: STORED.name, authType: STORED.authType },
      ]);
      expect(serviceMock.findOptions).toHaveBeenCalledWith(
        CredentialAuthType.BEARER_TOKEN,
      );
    });

    it('1.3 deberia rechazar un authType fuera del enum en /options', async () => {
      // 2. Act ⚙️
      const response = await request(httpServer()).get(
        '/credentials/options?authType=PLAIN',
      );

      // 3. Assert 🎯
      expect(response.status).toBe(400);
      expect(serviceMock.findOptions).not.toHaveBeenCalled();
    });
  });

  describe('2. ADMIN', () => {
    beforeEach(() => {
      currentUser = ADMIN_USER;
    });

    it('2.1 deberia listar sin filtrar jamas las columnas criptograficas', async () => {
      // 2. Act ⚙️
      const response = await request(httpServer()).get('/credentials');

      // 3. Assert 🎯
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain(LEAKY_CIPHERTEXT);
      expect(response.body).toEqual([
        {
          id: STORED.id,
          name: STORED.name,
          authType: STORED.authType,
          createdAt: '2026-10-24T08:00:00.000Z',
          updatedAt: '2026-10-24T08:00:00.000Z',
        },
      ]);
    });

    it('2.2 deberia dar de alta sin devolver el secreto recibido', async () => {
      // 2. Act ⚙️
      const response = await request(httpServer()).post('/credentials').send({
        name: 'API de becas',
        authType: CredentialAuthType.BEARER_TOKEN,
        token: 'tok_que_no_debe_volver',
      });

      // 3. Assert 🎯
      expect(response.status).toBe(201);
      expect(JSON.stringify(response.body)).not.toContain(
        'tok_que_no_debe_volver',
      );
      expect(serviceMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'tok_que_no_debe_volver' }),
      );
    });

    it('2.3 deberia exigir el token de un BEARER_TOKEN', async () => {
      // 2. Act ⚙️
      const response = await request(httpServer())
        .post('/credentials')
        .send({ name: 'Sin token', authType: CredentialAuthType.BEARER_TOKEN });

      // 3. Assert 🎯
      expect(response.status).toBe(400);
      expect(serviceMock.create).not.toHaveBeenCalled();
    });

    it('2.4 deberia rechazar un keyName que inyecte cabeceras', async () => {
      // 2. Act ⚙️
      const response = await request(httpServer()).post('/credentials').send({
        name: 'Clave',
        authType: CredentialAuthType.API_KEY,
        keyName: 'X-Api-Key\r\nX-Admin: 1',
        apiKey: 'k',
        placement: 'HEADER',
      });

      // 3. Assert 🎯
      expect(response.status).toBe(400);
      expect(serviceMock.create).not.toHaveBeenCalled();
    });
  });
});
