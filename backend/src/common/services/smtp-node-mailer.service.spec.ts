import { createTransport } from 'nodemailer';

import { SmtpNodeMailerService } from '@common/services/smtp-node-mailer.service';

import type { ConfigService } from '@nestjs/config';

// El transporte real abre un socket contra el relay en cuanto se construye.
// Aqui solo interesa CON QUE se construye, de modo que se sustituye la factoria
// entera por un doble que recuerda sus opciones. Mismo patron que
// `imap-client.factory.spec.ts`.
jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockReturnValue({
    sendMail: jest.fn(),
    close: jest.fn(),
  }),
}));

const createTransportMock = createTransport as unknown as jest.Mock;

const ENV: Record<string, string> = {
  SMTP_NODE_HOST: 'smtp.unuware.com',
  SMTP_NODE_PORT: '587',
  SMTP_NODE_USER: 'avisos@unuware.com',
  SMTP_NODE_PASS: 'secreto',
};

const buildService = (): SmtpNodeMailerService => {
  const configService = {
    get: jest.fn((key: string) => ENV[key]),
  } as unknown as ConfigService;

  return new SmtpNodeMailerService(configService);
};

/**
 * Opciones con las que se construyo el ultimo transporte, ya tipadas.
 *
 * `mock.calls` es `any[]` y el lint del repositorio rechaza navegarlo a pelo:
 * se anota la tupla en un solo sitio en vez de castear en cada prueba.
 */
const lastOptions = (): Record<string, unknown> => {
  const calls = createTransportMock.mock.calls as [Record<string, unknown>][];
  const last = calls.at(-1);

  if (last === undefined) {
    throw new Error('No se construyo ningun transporte SMTP.');
  }

  return last[0];
};

describe('SmtpNodeMailerService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * EL DEFECTO QUE CIERRA ESTE BLOQUE. El transporte no declaraba ni un tope,
   * y el motor NO impone ninguno sobre `strategy.execute()`: un relay que
   * acepta la conexion y deja de responder congelaba el paso del pipeline —y
   * con el, el worker que lo disparo— sin limite.
   */
  describe('1. Topes de tiempo del transporte', () => {
    it('1.1 deberia acotar conexion, saludo e inactividad del socket', () => {
      // 1. Arrange 📐 & 2. Act ⚙️
      buildService();

      // 3. Assert 🎯: los tres, porque cubren fases distintas. Solo el de
      //    conexion dejaria colgado a un servidor que acepta el socket y calla.
      expect(lastOptions()).toMatchObject({
        connectionTimeout: 10_000,
        greetingTimeout: 5_000,
        socketTimeout: 15_000,
      });
    });

    it('1.2 no deberia perder la configuracion del pool al anadirlos', () => {
      // 1. Arrange 📐: control de regresion. Los topes se anaden al mismo
      //    literal que gobierna la conexion persistente.
      buildService();

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(lastOptions()).toMatchObject({
        host: 'smtp.unuware.com',
        pool: true,
        secure: false,
      });
    });
  });
});
