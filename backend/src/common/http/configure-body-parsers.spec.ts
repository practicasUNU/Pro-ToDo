import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import {
  SANDBOX_RUN_PATH,
  configureBodyParsers,
} from '@common/http/configure-body-parsers';

import type { NestExpressApplication } from '@nestjs/platform-express';

/** Por encima de los 100 KB del parser global y muy por debajo de los 10 MB. */
const OVERSIZED_BYTES = 200 * 1024;

/** Devuelve el cuerpo tal como llega al controlador, para ver si se parseo. */
@Controller()
class EchoController {
  @Post('echo')
  @HttpCode(200)
  echo(@Body() body: Record<string, unknown>): Record<string, unknown> {
    return { body: body ?? null };
  }

  @Post('nodes/sandbox/run')
  @HttpCode(200)
  sandbox(@Body() body: { blob?: string }): { size: number } {
    return { size: body?.blob?.length ?? 0 };
  }
}

describe('configureBodyParsers', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EchoController],
    }).compile();

    // Igual que main.ts: sin el parser automatico de Nest. Sin logger, para
    // que el 413 esperado de 1.3 no ensucie la salida con su traza.
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    app.setGlobalPrefix('api');
    configureBodyParsers(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('1.1 deberia entregar el cuerpo JSON a las rutas normales (regresion del login)', async () => {
    // 1. Arrange 📐: el payload exacto de `POST /auth/otp/generate`. Con el
    //    parser global ausente llegaba vacio y el DTO respondia 400.
    const payload = { email: 'usuario@unuware.com' };

    // 2. Act ⚙️
    const response = await request(app.getHttpServer())
      .post('/api/echo')
      .send(payload);

    // 3. Assert 🎯
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ body: payload });
  });

  it('1.2 deberia parsear un cuerpo urlencoded', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const response = await request(app.getHttpServer())
      .post('/api/echo')
      .type('form')
      .send('email=usuario%40unuware.com');

    // 3. Assert 🎯
    expect(response.body).toEqual({ body: { email: 'usuario@unuware.com' } });
  });

  it('1.3 deberia rechazar con 413 un JSON grande fuera del banco de pruebas', async () => {
    // 1. Arrange 📐: el limite ampliado NO debe filtrarse al resto de la API.
    const payload = { blob: 'x'.repeat(OVERSIZED_BYTES) };

    // 2. Act ⚙️
    const response = await request(app.getHttpServer())
      .post('/api/echo')
      .send(payload);

    // 3. Assert 🎯
    expect(response.status).toBe(413);
  });

  it('1.4 deberia aceptar un JSON grande en la ruta del banco de pruebas', async () => {
    // 1. Arrange 📐: un adjunto OCR en base64 supera de largo los 100 KB.
    const payload = { blob: 'x'.repeat(OVERSIZED_BYTES) };

    // 2. Act ⚙️
    const response = await request(app.getHttpServer())
      .post(SANDBOX_RUN_PATH)
      .send(payload);

    // 3. Assert 🎯
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ size: OVERSIZED_BYTES });
  });
});
