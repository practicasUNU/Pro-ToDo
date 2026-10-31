import { Test } from '@nestjs/testing';
import request from 'supertest';

import { DrupalApiConfig } from '@core/config/drupal-api.config';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { DrupalTargetsController } from '@modules/nodes/controllers/drupal-targets.controller';
import { UserRole } from '@modules/users/enums/user-role.enum';

import type { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';
import type { DrupalPresetTargetsResponseDto } from '@modules/nodes/dto/drupal-preset-targets.dto';
import type { App } from 'supertest/types';

/**
 * Suite del PERIMETRO HTTP: la resolucion de la tabla vive en
 * `drupal-api.config.spec.ts`. Se usa el `DrupalApiConfig` REAL sobre un
 * entorno simulado, para que la prueba fije la forma que de verdad sale.
 */

const EDITOR_USER: AuthenticatedUser = {
  id: 'b27d9e10-4c3f-4a8b-9f21-6d5e4c3b2a19',
  email: 'editor@unuware.com',
  role: UserRole.EDITOR,
};

const LICITACIONES = '7f1700bf-b54b-4c12-b71a-8a71f1f0ee38';
const INNODAYS = '3c2b1a0f-9e8d-4c7b-8a69-5f4e3d2c1b0a';

const ENV: Record<string, string> = {
  DRUPAL_SANDBOX_LICITACIONES_UUID: LICITACIONES,
  DRUPAL_SANDBOX_LICITACIONES_NID: '55937',
  DRUPAL_SANDBOX_INNODAYS_UUID: INNODAYS,
  DRUPAL_API_TOKEN: 'secreto-que-no-debe-salir',
};

describe('DrupalTargetsController · perimetro de /api/nodos/drupal/targets', () => {
  let app: INestApplication;
  /** Identidad que el JwtAuthGuard doble inyecta en `req.user`. */
  let currentUser: AuthenticatedUser | undefined;

  beforeAll(async () => {
    const configService = {
      get: (variable: string) => ENV[variable],
    } as unknown as ConfigService;

    const moduleRef = await Test.createTestingModule({
      controllers: [DrupalTargetsController],
      providers: [
        {
          provide: DrupalApiConfig,
          useValue: new DrupalApiConfig(configService),
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
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    currentUser = EDITOR_USER;
  });

  it('1.1 deberia servir las paginas por entorno y preset a un EDITOR', async () => {
    // 2. Act ⚙️
    const response = await request(app.getHttpServer() as App).get(
      '/nodos/drupal/targets',
    );

    // 3. Assert 🎯: Innobar hereda la pagina de pruebas de Innodays.
    expect(response.status).toBe(200);
    const body = response.body as DrupalPresetTargetsResponseDto;
    expect(body.SANDBOX.ABRIR_LICITACION).toEqual({
      targetNodeUuid: LICITACIONES,
      destinationNodeUuid: null,
      nid: 55937,
    });
    expect(body.SANDBOX.INNOBAR.targetNodeUuid).toBe(INNODAYS);
    expect(Object.keys(body.PRODUCTION)).toHaveLength(6);
  });

  it('1.2 NO deberia filtrar ninguna credencial en la respuesta', async () => {
    // 2. Act ⚙️
    const response = await request(app.getHttpServer() as App).get(
      '/nodos/drupal/targets',
    );

    // 3. Assert 🎯: solo identificadores publicos de paginas.
    expect(response.text).not.toContain('secreto-que-no-debe-salir');
  });

  it('1.3 deberia responder 403 a un rol desconocido', async () => {
    // 1. Arrange 📐
    currentUser = { ...EDITOR_USER, role: 'INVITADO' as UserRole };

    // 2. Act ⚙️
    const response = await request(app.getHttpServer() as App).get(
      '/nodos/drupal/targets',
    );

    // 3. Assert 🎯
    expect(response.status).toBe(403);
  });
});
