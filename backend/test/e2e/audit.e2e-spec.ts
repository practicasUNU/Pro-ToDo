// ---------------------------------------------------------------------------
// AISLAMIENTO. Va ANTES de cualquier import de la aplicacion, y no es opcional:
// `ConfigModule` no sobrescribe lo que ya esta en `process.env`, asi que esto
// gana sobre `backend/.env` (ver `executions-resume.e2e-spec.ts`).
// ---------------------------------------------------------------------------
process.env.IMAP_POLLING_ENABLED = 'false';
process.env.CRON_SCHEDULING_ENABLED = 'false';
process.env.INBOUND_RESUME_ENABLED = 'false';
// La base sale de `DB_NAME` del entorno y la valida `test/helpers/e2e-database.guard.ts`
// (cargado por `setupFiles`) antes de este archivo: nada de nombres escritos aqui.

import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { createGlobalValidationPipe } from '@common/pipes/global-validation.pipe';

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

/** EDITOR propio de esta suite (ver `e2eEditor`). */
const E2E_EDITOR = e2eEditor(E2E_SLOTS.AUDIT, 'editor-auditoria');

/** Arrancar Nest y conectar con PostgreSQL excede el timeout por defecto. */
const BOOTSTRAP_TIMEOUT_MS = 30_000;

/** Rango de documentacion (RFC 5737): nunca colisiona con una IP real. */
const E2E_CIDR = '203.0.113.77/32';

/** Fila de `audit_eventos` tal como sale de `pg`. */
interface AuditRow {
  usuario_id: string | null;
  accion: string;
  tabla_afectada: string;
  registro_id: string | null;
  datos_anteriores: Record<string, unknown> | null;
  datos_nuevos: Record<string, unknown> | null;
  ip_origen: string | null;
}

describe('Auditoria de acciones humanas (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;
  let editorToken: string;
  let adminId: string;
  let createdId: string | null = null;

  const httpServer = (): App => app.getHttpServer() as App;

  const eventsOf = (recordId: string): Promise<AuditRow[]> =>
    dataSource.query<AuditRow[]>(
      `SELECT * FROM audit_eventos WHERE registro_id = $1 ORDER BY creado_en`,
      [recordId],
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();

    dataSource = app.get(DataSource);

    // Un ADMIN REAL: `audit_eventos.usuario_id` tiene FK a `usuarios`, y con
    // un id inventado el registro (best-effort) se perderia en silencio. Y un
    // EDITOR real tambien: desde la 051, `JwtStrategy` consulta `usuarios`, y
    // un id inventado recibiria un 401 en vez del 403 que se quiere probar.
    const jwtService = app.get(JwtService);
    const admin = await findActiveAdmin(dataSource);
    adminId = admin.id;
    adminToken = await signFor(jwtService, dataSource, admin);
    await ensureE2eUser(dataSource, E2E_EDITOR);
    editorToken = await signFor(jwtService, dataSource, E2E_EDITOR);

    // Restos de una ejecucion abortada.
    await dataSource.query(`DELETE FROM allowed_ips WHERE ip_o_cidr = $1`, [
      E2E_CIDR,
    ]);
  }, BOOTSTRAP_TIMEOUT_MS);

  afterAll(async () => {
    await dataSource.query(`DELETE FROM allowed_ips WHERE ip_o_cidr = $1`, [
      E2E_CIDR,
    ]);

    if (createdId !== null) {
      await dataSource.query(
        `DELETE FROM audit_eventos WHERE registro_id = $1`,
        [createdId],
      );
    }

    await removeE2eUsers(dataSource, [E2E_EDITOR]);
    await app.close();
  });

  it('1.1 deberia registrar el alta con actor, IP y fotografia nueva', async () => {
    // 2. Act ⚙️
    const response = await request(httpServer())
      .post('/api/allowed-ips')
      .set('Authorization', `Bearer ${adminToken}`)
      // Loopback: el `IpWhitelistGuard` global rechaza cualquier IP ajena, y
      // fijarla por cabecera hace determinista lo que se espera en `ip_origen`.
      .set('X-Forwarded-For', '127.0.0.1')
      .send({ ipOrCidr: E2E_CIDR, description: 'Red e2e de auditoria' })
      .expect(201);
    createdId = (response.body as { id: string }).id;

    // 3. Assert 🎯
    const [event] = await eventsOf(createdId);
    expect(event).toMatchObject({
      usuario_id: adminId,
      accion: 'CREAR',
      tabla_afectada: 'allowed_ips',
      datos_anteriores: null,
      ip_origen: '127.0.0.1',
    });
    expect(event.datos_nuevos).toMatchObject({
      ipOrCidr: E2E_CIDR,
      createdByUserId: adminId,
    });
    expect(response.body).toMatchObject({
      createdBy: { id: adminId },
      updatedBy: { id: adminId },
    });
  });

  it('1.2 deberia registrar la modificacion con el antes y el despues', async () => {
    // 2. Act ⚙️
    await request(httpServer())
      .patch(`/api/allowed-ips/${createdId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ description: 'Red e2e renombrada' })
      .expect(200);

    // 3. Assert 🎯
    const events = await eventsOf(createdId as string);
    const update = events.find((event) => event.accion === 'ACTUALIZAR');
    expect(update?.datos_anteriores).toMatchObject({
      description: 'Red e2e de auditoria',
    });
    expect(update?.datos_nuevos).toMatchObject({
      description: 'Red e2e renombrada',
    });
  });

  it('1.3 deberia servir los eventos filtrados al ADMIN por la API', async () => {
    // 2. Act ⚙️
    const response = await request(httpServer())
      .get('/api/audit/events?affectedTable=allowed_ips&limit=100')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // 3. Assert 🎯
    const body = response.body as {
      items: Array<{ recordId: string; action: string; userEmail: string }>;
    };
    const mine = body.items.filter((item) => item.recordId === createdId);
    expect(mine.map((item) => item.action).sort()).toEqual([
      'ACTUALIZAR',
      'CREAR',
    ]);
    expect(mine[0].userEmail).toContain('@');
  });

  it('1.4 deberia responder 403 al EDITOR', async () => {
    // 2. Act ⚙️ + 3. Assert 🎯
    await request(httpServer())
      .get('/api/audit/events')
      .set('Authorization', `Bearer ${editorToken}`)
      .expect(403);
  });

  it('1.5 deberia registrar la baja fisica sin fotografia nueva', async () => {
    // 2. Act ⚙️
    await request(httpServer())
      .delete(`/api/allowed-ips/${createdId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // 3. Assert 🎯
    const events = await eventsOf(createdId as string);
    const removal = events.find((event) => event.accion === 'ELIMINAR');
    expect(removal?.datos_anteriores).toMatchObject({ ipOrCidr: E2E_CIDR });
    expect(removal?.datos_nuevos).toBeNull();
  });
});
