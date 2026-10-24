// ---------------------------------------------------------------------------
// AISLAMIENTO. Va ANTES de cualquier import de la aplicacion, y no es opcional:
// `ConfigModule` no sobrescribe lo que ya esta en `process.env`, asi que esto
// gana sobre `backend/.env` (ver `executions-resume.e2e-spec.ts`).
// ---------------------------------------------------------------------------
process.env.IMAP_POLLING_ENABLED = 'false';
process.env.CRON_SCHEDULING_ENABLED = 'false';
process.env.INBOUND_RESUME_ENABLED = 'false';
process.env.DB_NAME = process.env.E2E_DB_NAME ?? '<nombre_bd_test>';

import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { createGlobalValidationPipe } from '@common/pipes/global-validation.pipe';
import { generateDevJwt } from '@common/utils/dev-jwt.util';
import { UserRole } from '@modules/users/enums/user-role.enum';

import { AppModule } from '../../src/app.module';
import {
  E2E_SLOTS,
  e2eEditor,
  ensureE2eUser,
  findActiveAdmin,
  removeE2eUsers,
  signFor,
} from '../helpers/e2e-users.helper';

import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';

/**
 * Pruebas "a mala leche" de la frontera HTTP (GUIA_PRUEBAS_MALA_LECHE.md).
 *
 * Contra PostgreSQL REAL y con el `ValidationPipe` de produccion: lo que se
 * prueba aqui —que un `sortBy` hostil no llega al SQL, que el relevo de tarifas
 * deja exactamente una vigente, que un token revocado deja de valer en la
 * peticion siguiente— solo se demuestra con la base de verdad. Un doble del
 * QueryBuilder no ejecuta ni el `ORDER BY` ni el indice parcial.
 */

/** Arrancar Nest y conectar con PostgreSQL excede el timeout por defecto. */
const BOOTSTRAP_TIMEOUT_MS = 30_000;

const E2E_EDITOR = e2eEditor(E2E_SLOTS.RESILIENCE_EDITOR, 'editor-mala-leche');
const E2E_REVOKED = e2eEditor(
  E2E_SLOTS.RESILIENCE_REVOKED,
  'revocado-mala-leche',
);

/** Prefijo de los modelos sembrados: el `afterAll` borra por el, nunca a ciegas. */
const MODEL_PREFIX = `e2e-mala-leche-${Date.now()}`;

const RATES = {
  promptRateUsdPerMTok: 1.5,
  completionRateUsdPerMTok: 6,
  reasoningRateUsdPerMTok: 6,
};

/** Endpoints con orden en servidor y una clave valida de cada uno. */
const SORTABLE_ENDPOINTS = [
  { path: '/api/executions', validKey: 'startedAt', admin: false },
  { path: '/api/telemetry/history', validKey: 'flow', admin: false },
  { path: '/api/audit/events', validKey: 'user', admin: true },
  { path: '/api/pricing', validKey: 'aiModel', admin: true },
] as const;

interface PricingRow {
  id_precio_modelo_ia: string;
  modelo_ia: string;
  activo: boolean;
}

describe('Resiliencia de entradas y pruebas a mala leche (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let adminToken: string;
  let editorToken: string;

  const httpServer = (): App => app.getHttpServer() as App;

  const rowsOf = (model: string): Promise<PricingRow[]> =>
    dataSource.query<PricingRow[]>(
      `SELECT id_precio_modelo_ia, modelo_ia, activo FROM precios_modelos_ia
        WHERE proveedor_ia = 'OPENAI' AND modelo_ia = $1 ORDER BY vigente_desde`,
      [model],
    );

  const postTariff = (body: Record<string, unknown>, token = adminToken) =>
    request(httpServer())
      .post('/api/pricing')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();

    dataSource = app.get(DataSource);
    jwtService = app.get(JwtService);

    const admin = await findActiveAdmin(dataSource);
    adminToken = await signFor(jwtService, dataSource, admin);
    await ensureE2eUser(dataSource, E2E_EDITOR);
    await ensureE2eUser(dataSource, E2E_REVOKED);
    editorToken = await signFor(jwtService, dataSource, E2E_EDITOR);
  }, BOOTSTRAP_TIMEOUT_MS);

  afterAll(async () => {
    const seeded = await dataSource.query<Array<{ id: string }>>(
      `SELECT id_precio_modelo_ia AS id FROM precios_modelos_ia WHERE modelo_ia LIKE $1`,
      [`${MODEL_PREFIX}%`],
    );

    if (seeded.length > 0) {
      await dataSource.query(
        `DELETE FROM audit_eventos WHERE registro_id = ANY($1)`,
        [seeded.map((row) => row.id)],
      );
      await dataSource.query(
        `DELETE FROM precios_modelos_ia WHERE modelo_ia LIKE $1`,
        [`${MODEL_PREFIX}%`],
      );
    }

    await removeE2eUsers(dataSource, [E2E_EDITOR, E2E_REVOKED]);
    await app.close();
  });

  describe('1. Tarifas: relevo atomico contra PostgreSQL real', () => {
    const model = `${MODEL_PREFIX}-relevo`;

    it('1.1 deberia guardar el modelo RECORTADO', async () => {
      // 2. Act ⚙️
      const response = await postTariff({
        aiProvider: 'OPENAI',
        aiModel: `   ${model}   `,
        ...RATES,
      });

      // 3. Assert 🎯
      expect(response.status).toBe(201);
      const rows = await rowsOf(model);
      expect(rows).toHaveLength(1);
      expect(rows[0].activo).toBe(true);
    });

    it('1.2 deberia dejar EXACTAMENTE una vigente tras el relevo y auditar la saliente', async () => {
      // 1. Arrange 📐
      const [previous] = await rowsOf(model);

      // 2. Act ⚙️
      const response = await postTariff({
        aiProvider: 'OPENAI',
        aiModel: model,
        ...RATES,
        promptRateUsdPerMTok: 2,
      });

      // 3. Assert 🎯
      expect(response.status).toBe(201);
      const rows = await rowsOf(model);
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.activo)).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id_precio_modelo_ia: previous.id_precio_modelo_ia,
        activo: false,
      });

      const events = await dataSource.query<Array<{ accion: string }>>(
        `SELECT accion FROM audit_eventos WHERE registro_id = $1`,
        [previous.id_precio_modelo_ia],
      );
      expect(events.map((event) => event.accion).sort()).toEqual([
        'CREAR',
        'DESACTIVAR',
      ]);
    });

    it('1.3 deberia rechazar con 409 una tarifa identica a la vigente', async () => {
      // 2. Act ⚙️
      const response = await postTariff({
        aiProvider: 'OPENAI',
        aiModel: model,
        ...RATES,
        promptRateUsdPerMTok: 2,
      });

      // 3. Assert 🎯
      expect(response.status).toBe(409);
      expect(await rowsOf(model)).toHaveLength(2);
    });

    it('1.4 dos ADMIN a la vez sobre un par NUEVO: jamas dos vigentes', async () => {
      // 1. Arrange 📐: sin vigente previa no hay fila que bloquear; lo que
      //    impide la doble alta es el indice parcial de la migracion 052.
      const racedModel = `${MODEL_PREFIX}-carrera`;

      // 2. Act ⚙️
      const responses = await Promise.all(
        [1, 2, 3].map((n) =>
          postTariff({
            aiProvider: 'OPENAI',
            aiModel: racedModel,
            ...RATES,
            promptRateUsdPerMTok: n,
          }),
        ),
      );

      // 3. Assert 🎯: cada peticion acaba en 201 (relevo serializado) o 409
      //    (choque detectado); nunca en 500 ni en dos vigentes.
      for (const response of responses) {
        expect([201, 409]).toContain(response.status);
      }
      const rows = await rowsOf(racedModel);
      expect(rows.filter((row) => row.activo)).toHaveLength(1);
    });

    it.each([
      ['un campo de mas (forbidNonWhitelisted)', { active: false }],
      ['una vigencia impuesta', { validFrom: '2030-01-01T00:00:00Z' }],
      ['el proveedor MOCK', { aiProvider: 'MOCK' }],
      ['una tarifa negativa', { promptRateUsdPerMTok: -0.01 }],
      ['notacion exponencial en texto', { promptRateUsdPerMTok: '1e3' }],
      ['un desbordamiento de NUMERIC(12,6)', { promptRateUsdPerMTok: 1e7 }],
      ['XSS en el modelo', { aiModel: '<img src=x onerror=alert(1)>' }],
      ['SQL en el modelo', { aiModel: "gpt'; DROP TABLE usuarios;--" }],
    ])('1.5 deberia responder 400 a %s', async (_label, patch) => {
      // 2. Act ⚙️
      const response = await postTariff({
        aiProvider: 'OPENAI',
        aiModel: `${MODEL_PREFIX}-rechazo`,
        ...RATES,
        ...patch,
      });

      // 3. Assert 🎯
      expect(response.status).toBe(400);
      expect(await rowsOf(`${MODEL_PREFIX}-rechazo`)).toHaveLength(0);
    });

    it('1.6 deberia responder 403 al EDITOR, tambien en la lectura', async () => {
      // 2. Act ⚙️ + 3. Assert 🎯
      await request(httpServer())
        .get('/api/pricing')
        .set('Authorization', `Bearer ${editorToken}`)
        .expect(403);
      await postTariff(
        { aiProvider: 'OPENAI', aiModel: `${MODEL_PREFIX}-editor`, ...RATES },
        editorToken,
      ).expect(403);
    });

    it.each(['patch', 'delete'] as const)(
      '1.7 NO deberia existir %s sobre una tarifa',
      async (verb) => {
        // 1. Arrange 📐
        const [row] = await rowsOf(model);

        // 2. Act ⚙️
        const response = await request(httpServer())
          [verb](`/api/pricing/${row.id_precio_modelo_ia}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ active: false });

        // 3. Assert 🎯
        expect(response.status).toBe(404);
      },
    );
  });

  describe('2. Orden en servidor: lista blanca contra SQLi', () => {
    it.each(SORTABLE_ENDPOINTS)(
      '2.1 $path deberia ordenar con una clave valida en ambos sentidos',
      async ({ path, validKey, admin }) => {
        // 2. Act ⚙️: contra Postgres real, con JOIN y take/skip donde los hay.
        for (const sortOrder of ['ASC', 'desc']) {
          const response = await request(httpServer())
            .get(`${path}?sortBy=${validKey}&sortOrder=${sortOrder}&limit=5`)
            .set('Authorization', `Bearer ${admin ? adminToken : editorToken}`);

          // 3. Assert 🎯
          expect(response.status).toBe(200);
        }
      },
    );

    it.each(
      SORTABLE_ENDPOINTS.flatMap(({ path, admin }) =>
        [
          'createdAt;DROP TABLE usuarios--',
          '(SELECT pg_sleep(5))',
          '1',
          'constructor',
          'e.creado_en',
        ].map((sortBy) => ({ path, admin, sortBy })),
      ),
    )(
      '2.2 $path deberia responder 400 a sortBy=$sortBy',
      async ({ path, admin, sortBy }) => {
        // 2. Act ⚙️
        const response = await request(httpServer())
          .get(path)
          .query({ sortBy })
          .set('Authorization', `Bearer ${admin ? adminToken : editorToken}`);

        // 3. Assert 🎯
        expect(response.status).toBe(400);
      },
    );

    it.each(SORTABLE_ENDPOINTS)(
      '2.3 $path deberia rechazar una direccion compuesta y un sortBy en array',
      async ({ path, validKey, admin }) => {
        // 1. Arrange 📐
        const token = `Bearer ${admin ? adminToken : editorToken}`;

        // 2. Act ⚙️ + 3. Assert 🎯
        await request(httpServer())
          .get(`${path}?sortBy=${validKey}&sortOrder=asc,id`)
          .set('Authorization', token)
          .expect(400);
        await request(httpServer())
          .get(`${path}?sortBy[]=${validKey}`)
          .set('Authorization', token)
          .expect(400);
      },
    );

    it('2.4 la tabla de usuarios deberia seguir en pie tras la tanda', async () => {
      // 3. Assert 🎯: la prueba mas literal de que ninguna inyeccion se ejecuto.
      const [row] = await dataSource.query<Array<{ total: string }>>(
        `SELECT count(*)::text AS total FROM usuarios`,
      );
      expect(Number(row.total)).toBeGreaterThan(0);
    });
  });

  describe('3. Busqueda y parametros desbordados', () => {
    it('3.1 deberia rechazar una busqueda de mas de 100 caracteres', async () => {
      // 2. Act ⚙️ + 3. Assert 🎯
      await request(httpServer())
        .get('/api/pricing')
        .query({ search: 'x'.repeat(101) })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('3.2 deberia tratar los comodines de LIKE como texto literal', async () => {
      // 1. Arrange 📐: sin escape, `%` devolveria la tabla entera.
      // 2. Act ⚙️
      const response = await request(httpServer())
        .get('/api/pricing')
        .query({ search: '%' })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      // 3. Assert 🎯
      expect((response.body as { total: number }).total).toBe(0);
    });

    it('3.3 deberia recortar una busqueda y encontrar igual', async () => {
      // 2. Act ⚙️
      const response = await request(httpServer())
        .get('/api/pricing')
        .query({ search: `   ${MODEL_PREFIX}-relevo   ` })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      // 3. Assert 🎯
      expect((response.body as { total: number }).total).toBe(2);
    });

    it.each([
      ['un parametro desconocido', { debug: 'true' }],
      ['un limit gigante', { limit: '100000' }],
      ['un limit no numerico', { limit: 'abc' }],
      ['un booleano ambiguo', { activeOnly: 'si' }],
      ['un rango invertido', { from: '2026-10-22', to: '2026-10-01' }],
    ])('3.4 deberia responder 400 a %s', async (_label, query) => {
      // 2. Act ⚙️ + 3. Assert 🎯
      await request(httpServer())
        .get('/api/pricing')
        .query(query)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });
  });

  describe('4. Revocacion del JWT por tokenVersion', () => {
    it('4.1 deberia cortar un token vivo en la peticion SIGUIENTE a subir la generacion', async () => {
      // 1. Arrange 📐: el token funciona...
      const token = await signFor(jwtService, dataSource, E2E_REVOKED);
      await request(httpServer())
        .get('/api/executions?limit=1')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // 2. Act ⚙️: ...hasta que alguien cambia la cuenta.
      await dataSource.query(
        `UPDATE usuarios SET token_version = token_version + 1 WHERE id_usuario = $1`,
        [E2E_REVOKED.id],
      );

      // 3. Assert 🎯: sin esperar a que caduque, sin cache.
      await request(httpServer())
        .get('/api/executions?limit=1')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('4.2 deberia aceptar el token REEMITIDO con la generacion nueva', async () => {
      // 1. Arrange 📐
      const fresh = await signFor(jwtService, dataSource, E2E_REVOKED);

      // 2. Act ⚙️ + 3. Assert 🎯
      await request(httpServer())
        .get('/api/executions?limit=1')
        .set('Authorization', `Bearer ${fresh}`)
        .expect(200);
    });

    it('4.3 deberia cortar el token de una cuenta desactivada', async () => {
      // 1. Arrange 📐
      const token = await signFor(jwtService, dataSource, E2E_REVOKED);
      await dataSource.query(
        `UPDATE usuarios SET activo = FALSE WHERE id_usuario = $1`,
        [E2E_REVOKED.id],
      );

      // 2. Act ⚙️ + 3. Assert 🎯
      await request(httpServer())
        .get('/api/executions?limit=1')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('4.4 deberia responder 401 —y no 500— a un token firmado con un `sub` que no es UUID', async () => {
      // 1. Arrange 📐: el `sub` llega a una columna UUID de PostgreSQL. Sin
      //    guarda, el driver lanza `invalid input syntax for type uuid` y el
      //    cliente veria un 500 que ademas delata el motor de base de datos.
      const token = generateDevJwt(jwtService, {
        userId: "x' OR '1'='1",
        email: 'atacante@unuware.com',
        role: UserRole.ADMIN,
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      await request(httpServer())
        .get('/api/executions?limit=1')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('4.5 deberia rechazar un token con la firma alterada', async () => {
      // 1. Arrange 📐
      const token = await signFor(jwtService, dataSource, E2E_EDITOR);
      const tampered = `${token.slice(0, -4)}AAAA`;

      // 2. Act ⚙️ + 3. Assert 🎯
      await request(httpServer())
        .get('/api/executions?limit=1')
        .set('Authorization', `Bearer ${tampered}`)
        .expect(401);
    });
  });
});
