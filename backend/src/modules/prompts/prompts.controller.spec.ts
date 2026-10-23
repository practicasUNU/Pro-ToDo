import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';

import { OTP_THROTTLER_NAME } from '@common/constants/throttler.constants';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { PromptOptimizerService } from '@modules/prompts/prompt-optimizer.service';
import { PromptsController } from '@modules/prompts/prompts.controller';
import { UserRole } from '@modules/users/enums/user-role.enum';

import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';

const EDITOR_USER: AuthenticatedUser = {
  id: 'b27d9e10-4c3f-4a8b-9f21-6d5e4c3b2a19',
  email: 'editor@unuware.com',
  role: UserRole.EDITOR,
};

const RESPONSE = {
  optimizedPrompt: 'Eres un redactor institucional.',
  recommendations: ['Se anadio un rol.'],
  telemetry: {
    tokensPrompt: 10,
    tokensCompletion: 20,
    tokensReasoning: 0,
    estimatedCostUSD: 0.0001,
    isEstimated: false,
    provider: 'GEMINI',
    model: 'gemini-3.6-flash',
  },
};

describe('PromptsController', () => {
  let app: INestApplication;
  let currentUser: AuthenticatedUser | undefined;
  const optimizer = { optimize: jest.fn().mockResolvedValue(RESPONSE) };

  beforeAll(async () => {
    // 1. Arrange 📐: RolesGuard y ThrottlerGuard autenticos, JwtAuthGuard sustituido.
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          { name: OTP_THROTTLER_NAME, ttl: 60_000, limit: 3 },
        ]),
      ],
      controllers: [PromptsController],
      providers: [{ provide: PromptOptimizerService, useValue: optimizer }],
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

  it('deberia optimizar con 200 y pasar el usuario al servicio', async () => {
    // 2. Act ⚙️
    const response = await request(httpServer())
      .post('/prompts/optimize')
      .send({ draftPrompt: 'Resume esto.', targetFormat: 'markdown' });

    // 3. Assert 🎯
    expect(response.status).toBe(200);
    expect(response.body).toEqual(RESPONSE);
    expect(optimizer.optimize).toHaveBeenCalledWith(
      { draftPrompt: 'Resume esto.', targetFormat: 'markdown' },
      EDITOR_USER,
    );
  });

  it('deberia rechazar con 400 un formato desconocido o un borrador vacio', async () => {
    // 2. Act ⚙️
    const badFormat = await request(httpServer())
      .post('/prompts/optimize')
      .send({ draftPrompt: 'x', targetFormat: 'yaml' });
    const emptyDraft = await request(httpServer())
      .post('/prompts/optimize')
      .send({ draftPrompt: '', targetFormat: 'text' });

    // 3. Assert 🎯
    expect(badFormat.status).toBe(400);
    expect(emptyDraft.status).toBe(400);
    expect(optimizer.optimize).not.toHaveBeenCalled();
  });

  it('deberia responder 403 a una sesion sin rol reconocido', async () => {
    // 1. Arrange 📐
    currentUser = { ...EDITOR_USER, role: 'INVITADO' as UserRole };

    // 2. Act ⚙️
    const response = await request(httpServer())
      .post('/prompts/optimize')
      .send({ draftPrompt: 'x', targetFormat: 'text' });

    // 3. Assert 🎯
    expect(response.status).toBe(403);
  });

  it('deberia frenar con 429 a partir de la undecima optimizacion por minuto', async () => {
    // 2. Act ⚙️: los tests anteriores ya consumieron parte del cupo.
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await request(httpServer())
        .post('/prompts/optimize')
        .send({ draftPrompt: 'x', targetFormat: 'text' });
      statuses.push(response.status);
    }

    // 3. Assert 🎯
    expect(statuses.at(-1)).toBe(429);
  });
});
