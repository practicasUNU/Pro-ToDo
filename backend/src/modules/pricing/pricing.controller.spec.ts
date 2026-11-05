import { Test } from '@nestjs/testing';
import request from 'supertest';

import { createGlobalValidationPipe } from '@common/pipes/global-validation.pipe';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { PricingController } from '@modules/pricing/pricing.controller';
import { PricingService } from '@modules/pricing/pricing.service';
import { UserRole } from '@modules/users/enums/user-role.enum';

import type { INestApplication } from '@nestjs/common';
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

const VALID_BODY = {
  aiProvider: 'GEMINI',
  aiModel: 'gemini-1.5-pro',
  promptRateUsdPerMTok: 1.5,
  completionRateUsdPerMTok: 6,
  reasoningRateUsdPerMTok: 6,
};

describe('PricingController', () => {
  let app: INestApplication;
  let currentUser: AuthenticatedUser | undefined;
  const pricingService = {
    findPage: jest.fn().mockResolvedValue(PAGE),
    create: jest.fn().mockResolvedValue({ id: 'nueva', active: true }),
  };

  beforeAll(async () => {
    // 1. Arrange 📐: RolesGuard autentico, JwtAuthGuard sustituido, y el MISMO
    //    pipe que `main.ts` (con `forbidNonWhitelisted`).
    const moduleRef = await Test.createTestingModule({
      controllers: [PricingController],
      providers: [{ provide: PricingService, useValue: pricingService }],
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
    currentUser = ADMIN_USER;
  });

  const httpServer = (): App => app.getHttpServer() as App;

  it('1.1 deberia servir al ADMIN la pagina con filtros y orden validados', async () => {
    // 2. Act ⚙️
    const response = await request(httpServer()).get(
      '/pricing?search=%20gemini%20&sortBy=aiModel&sortOrder=asc&activeOnly=true&limit=10',
    );

    // 3. Assert 🎯: `search` llega recortado y `sortOrder` en mayusculas.
    expect(response.status).toBe(200);
    expect(pricingService.findPage).toHaveBeenCalledWith(
      expect.objectContaining({
        search: 'gemini',
        sortBy: 'aiModel',
        sortOrder: 'ASC',
        activeOnly: true,
        limit: 10,
      }),
    );
  });

  it('1.2 deberia registrar la tarifa con el actor y el cuerpo recortado', async () => {
    // 2. Act ⚙️
    const response = await request(httpServer())
      .post('/pricing')
      .send({ ...VALID_BODY, aiModel: '  gemini-1.5-pro  ' });

    // 3. Assert 🎯
    expect(response.status).toBe(201);
    expect(pricingService.create).toHaveBeenCalledWith(
      expect.objectContaining({ aiModel: 'gemini-1.5-pro' }),
      ADMIN_USER.id,
      expect.anything(),
    );
  });

  it('1.3 deberia responder 403 al EDITOR en las dos rutas', async () => {
    // 1. Arrange 📐
    currentUser = EDITOR_USER;

    // 2. Act ⚙️ + 3. Assert 🎯
    await request(httpServer()).get('/pricing').expect(403);
    await request(httpServer()).post('/pricing').send(VALID_BODY).expect(403);
    expect(pricingService.create).not.toHaveBeenCalled();
  });

  it.each([
    ['PATCH', 'patch'],
    ['DELETE', 'delete'],
  ] as const)(
    '1.4 NO deberia existir %s: una tarifa no se edita ni se desactiva sola',
    async (_label, verb) => {
      // 2. Act ⚙️
      const response = await request(httpServer())[verb](
        '/pricing/0b7d3f5e-1111-4222-8333-944455556666',
      );

      // 3. Assert 🎯
      expect(response.status).toBe(404);
    },
  );

  it.each([
    [
      'un campo de mas (forbidNonWhitelisted)',
      { ...VALID_BODY, active: false },
    ],
    ['el proveedor MOCK', { ...VALID_BODY, aiProvider: 'MOCK' }],
    ['una tarifa negativa', { ...VALID_BODY, promptRateUsdPerMTok: -1 }],
    [
      'una tarifa en texto exponencial',
      { ...VALID_BODY, promptRateUsdPerMTok: '1e3' },
    ],
    ['mas de 6 decimales', { ...VALID_BODY, promptRateUsdPerMTok: 0.1234567 }],
    [
      'un modelo con espacios internos',
      { ...VALID_BODY, aiModel: 'gemini pro' },
    ],
    [
      'un modelo con comillas',
      { ...VALID_BODY, aiModel: "x'; DROP TABLE usuarios;--" },
    ],
    ['un modelo solo con espacios', { ...VALID_BODY, aiModel: '   ' }],
    [
      'una vigencia impuesta por el cliente',
      { ...VALID_BODY, validFrom: '2030-01-01' },
    ],
  ])('1.5 deberia rechazar con 400 %s', async (_label, body) => {
    // 2. Act ⚙️
    const response = await request(httpServer()).post('/pricing').send(body);

    // 3. Assert 🎯
    expect(response.status).toBe(400);
    expect(pricingService.create).not.toHaveBeenCalled();
  });

  it.each([
    ['inyeccion en sortBy', 'sortBy=validFrom;DROP%20TABLE%20usuarios'],
    ['columna SQL cruda', 'sortBy=vigente_desde'],
    ['sortBy en array', 'sortBy[]=aiModel'],
    ['direccion compuesta', 'sortOrder=asc,id'],
    ['busqueda desbordada', `search=${'a'.repeat(101)}`],
    ['booleano ambiguo', 'activeOnly=si'],
    ['parametro desconocido', 'debug=true'],
  ])('1.6 deberia rechazar con 400 %s en el listado', async (_label, qs) => {
    // 2. Act ⚙️
    const response = await request(httpServer()).get(`/pricing?${qs}`);

    // 3. Assert 🎯
    expect(response.status).toBe(400);
    expect(pricingService.findPage).not.toHaveBeenCalled();
  });
});
