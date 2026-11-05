import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { LlmCatalogController } from '@modules/nodes/controllers/llm-catalog.controller';
import { LlmProviderCatalogService } from '@modules/nodes/services/llm-provider-catalog.service';
import { LlmProvider } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import { UserRole } from '@modules/users/enums/user-role.enum';

import type { INestApplication } from '@nestjs/common';
import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';
import type {
  LlmModelDescriptor,
  LlmTestConnectionResponseDto,
} from '@modules/nodes/dto/llm-catalog.dto';
import type { App } from 'supertest/types';

/**
 * Suite del PERIMETRO HTTP, no de la logica del catalogo (esa vive en
 * `llm-provider-catalog.service.spec.ts`).
 *
 * Se levanta la aplicacion de verdad con el `RolesGuard` AUTENTICO y solo el
 * `JwtAuthGuard` sustituido, que es como se aisla la autorizacion de la
 * verificacion criptografica del token. Lo que se fija aqui es que un endpoint
 * que gasta dinero no quede abierto, y que un cuerpo con campos de mas se
 * rechace en vez de ejecutarse a medias.
 */

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

const CATALOG: LlmModelDescriptor[] = [
  {
    provider: LlmProvider.ANTHROPIC,
    model: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    isAvailable: true,
    isTestOnly: false,
    supportsVision: true,
    contextWindow: 1_000_000,
  },
];

const TEST_RESULT: LlmTestConnectionResponseDto = {
  success: true,
  latencyMs: 120,
  isMock: false,
  outputPreview: 'Conexion verificada',
};

describe('LlmCatalogController · perimetro de /api/llm', () => {
  let app: INestApplication;
  let catalogServiceMock: jest.Mocked<
    Pick<LlmProviderCatalogService, 'getAvailableModels' | 'testConnection'>
  >;
  /** Identidad que el JwtAuthGuard doble inyecta en `req.user`. */
  let currentUser: AuthenticatedUser | undefined;

  beforeAll(async () => {
    catalogServiceMock = {
      getAvailableModels: jest.fn().mockReturnValue(CATALOG),
      testConnection: jest.fn().mockResolvedValue(TEST_RESULT),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [LlmCatalogController],
      providers: [
        { provide: LlmProviderCatalogService, useValue: catalogServiceMock },
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
    // Mismo pipe global que `main.ts`, y eso importa: los pipes globales
    // corren ANTES que los de parametro, asi que su `whitelist` ya ha
    // depurado el cuerpo cuando el `STRICT_VALIDATION` del controlador lo
    // recibe. Montar la prueba sin el daria un 400 que la aplicacion real no
    // devuelve.
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
    currentUser = ADMIN_USER;
  });

  describe('1. GET /llm/models', () => {
    it('1.1 deberia devolver el catalogo a un ADMIN', async () => {
      // 1. Arrange 📐
      currentUser = ADMIN_USER;

      // 2. Act ⚙️
      const response = await request(app.getHttpServer() as App).get(
        '/llm/models',
      );

      // 3. Assert 🎯
      expect(response.status).toBe(200);
      expect(response.body).toEqual(CATALOG);
    });

    it('1.2 deberia devolver el catalogo tambien a un EDITOR', async () => {
      // 1. Arrange 📐: configurar flujos es competencia del EDITOR
      //    (`security-and-scope.md` §2); sin esto no podria elegir modelo.
      currentUser = EDITOR_USER;

      // 2. Act ⚙️
      const response = await request(app.getHttpServer() as App).get(
        '/llm/models',
      );

      // 3. Assert 🎯
      expect(response.status).toBe(200);
    });
  });

  describe('2. POST /llm/test-connection', () => {
    it('2.1 deberia responder 200 y delegar el cuerpo ya validado', async () => {
      // 1. Arrange 📐: es un POST por el cuerpo que lleva, no porque cree
      //    nada, de ahi el 200 y no el 201.
      currentUser = EDITOR_USER;

      // 2. Act ⚙️
      const response = await request(app.getHttpServer() as App)
        .post('/llm/test-connection')
        .send({ provider: LlmProvider.ANTHROPIC, model: 'claude-sonnet-5-5' });

      // 3. Assert 🎯
      expect(response.status).toBe(200);
      expect(response.body).toEqual(TEST_RESULT);
      expect(catalogServiceMock.testConnection).toHaveBeenCalledWith(
        {
          provider: LlmProvider.ANTHROPIC,
          model: 'claude-sonnet-5-5',
        },
        // Quien pulsa el boton firma la fila de telemetria.
        EDITOR_USER.id,
      );
    });

    it('2.2 deberia devolver 400 con un proveedor fuera del enum', async () => {
      // 1. Arrange 📐 & 2. Act ⚙️
      const response = await request(app.getHttpServer() as App)
        .post('/llm/test-connection')
        .send({ provider: 'OLLAMA', model: 'llama3' });

      // 3. Assert 🎯
      expect(response.status).toBe(400);
      expect(catalogServiceMock.testConnection).not.toHaveBeenCalled();
    });

    it('2.3 deberia devolver 400 si falta el modelo', async () => {
      // 1. Arrange 📐 & 2. Act ⚙️
      const response = await request(app.getHttpServer() as App)
        .post('/llm/test-connection')
        .send({ provider: LlmProvider.MOCK });

      // 3. Assert 🎯
      expect(response.status).toBe(400);
      expect(catalogServiceMock.testConnection).not.toHaveBeenCalled();
    });

    it('2.4 no deberia dejar que un prompt colado en el cuerpo llegue al proveedor', async () => {
      // 1. Arrange 📐: lo que se fija es que el coste de la llamada NO lo
      //    decida el cliente. El `whitelist` del pipe global descarta el campo
      //    antes de que el controlador lo vea, asi que la peticion sigue
      //    adelante —200, no 400— pero con el cuerpo depurado.
      currentUser = ADMIN_USER;

      // 2. Act ⚙️
      const response = await request(app.getHttpServer() as App)
        .post('/llm/test-connection')
        .send({
          provider: LlmProvider.MOCK,
          model: 'mock-engine',
          prompt: 'Redacta un informe de cuarenta paginas',
        });

      // 3. Assert 🎯: el servicio recibe exactamente los dos campos del DTO.
      expect(response.status).toBe(200);
      expect(catalogServiceMock.testConnection).toHaveBeenCalledWith(
        {
          provider: LlmProvider.MOCK,
          model: 'mock-engine',
        },
        ADMIN_USER.id,
      );
    });

    it('2.5 deberia propagar success:false como 200, no como error HTTP', async () => {
      // 1. Arrange 📐: que la conexion falle es el resultado que esta
      //    operacion viene a averiguar, no una excepcion.
      catalogServiceMock.testConnection.mockResolvedValue({
        success: false,
        latencyMs: 8_000,
        isMock: false,
        outputPreview: '',
        error: { level: 'GRAVE', message: 'El proveedor rechazo la peticion' },
      });

      // 2. Act ⚙️
      const response = await request(app.getHttpServer() as App)
        .post('/llm/test-connection')
        .send({ provider: LlmProvider.ANTHROPIC, model: 'claude-sonnet-5-5' });

      // 3. Assert 🎯
      expect(response.status).toBe(200);
      expect((response.body as LlmTestConnectionResponseDto).success).toBe(
        false,
      );
    });
  });

  describe('3. Perimetro de roles', () => {
    it.each([
      ['GET', '/llm/models'],
      ['POST', '/llm/test-connection'],
    ])(
      '3.1 %s %s deberia devolver 403 sin un rol reconocido',
      async (method, path) => {
        // 1. Arrange 📐: los guards se declaran a nivel de clase justamente
        //    para que ningun endpoint quede abierto por olvido. Esta prueba lo
        //    recorre entero para que anadir uno sin guardas se note.
        currentUser = undefined;

        // 2. Act ⚙️
        const agent = request(app.getHttpServer() as App);
        const response =
          method === 'GET'
            ? await agent.get(path)
            : await agent
                .post(path)
                .send({ provider: LlmProvider.MOCK, model: 'mock-engine' });

        // 3. Assert 🎯
        expect(response.status).toBe(403);
      },
    );
  });
});
