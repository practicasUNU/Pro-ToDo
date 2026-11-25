// ---------------------------------------------------------------------------
// AISLAMIENTO. Va ANTES de cualquier import de la aplicacion, y no es opcional:
// `ConfigModule` no sobrescribe lo que ya esta en `process.env`, asi que esto
// gana sobre `backend/.env`.
//
// Esta suite NO lo tenia: `npm run test:e2e` arrancaba el `AppModule` contra
// la base de DESARROLLO, con el sondeo IMAP, la reanudacion por correo y el
// cron del `.env` encendidos. Cada pasada dejaba un "[E2E] Pipeline dummy" mas
// en la base real (habia catorce) y abria el buzon corporativo. Detectado al
// preparar la purga de datos de prueba (docs/GUIA_PRUEBAS_MALA_LECHE.md §8).
// ---------------------------------------------------------------------------
process.env.IMAP_POLLING_ENABLED = 'false';
process.env.CRON_SCHEDULING_ENABLED = 'false';
process.env.INBOUND_RESUME_ENABLED = 'false';
// La base sale de `DB_NAME` del entorno y la valida `test/helpers/e2e-database.guard.ts`
// (cargado por `setupFiles`) antes de este archivo: nada de nombres escritos aqui.

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  afterEach(async () => {
    await app.close();
  });
});
