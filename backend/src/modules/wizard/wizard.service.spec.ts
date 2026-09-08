import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ImapTriggerConfigDto } from '@modules/nodes/dto/imap-trigger-config.dto';

import { CHECK_IMAP_SUCCESS_MESSAGE } from './dto/check-imap-response.dto';
import { WizardService } from './wizard.service';

import type { ConfigService } from '@nestjs/config';

// Cero red: `testing-standards.md` §2 prohibe conexiones reales a IMAP.
jest.mock('imapflow');

/* eslint-disable @typescript-eslint/no-require-imports */
const { ImapFlow } = require('imapflow') as { ImapFlow: jest.Mock };
/* eslint-enable @typescript-eslint/no-require-imports */

const PASSWORD_ENV_KEY = 'IMAP_PASSWORD';
const IMAP_PASSWORD = 'clave-de-buzon-solo-para-pruebas';

/** Cuerpo valido de la peticion del asistente. */
const buildDto = (
  overrides: Record<string, unknown> = {},
): ImapTriggerConfigDto =>
  plainToInstance(ImapTriggerConfigDto, {
    host: 'imap.unuware.com',
    port: 993,
    secure: true,
    user: 'notiweb@unuware.com',
    passwordEnvKey: PASSWORD_ENV_KEY,
    mailbox: 'INBOX',
    ...overrides,
  });

/** Doble del cliente: la comprobacion solo usa connect, status y logout. */
const buildClient = (
  overrides: Record<string, jest.Mock> = {},
): Record<string, jest.Mock> => ({
  connect: jest.fn().mockResolvedValue(undefined),
  status: jest.fn().mockResolvedValue({ path: 'INBOX', messages: 12 }),
  logout: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
  ...overrides,
});

const useClient = (client: Record<string, jest.Mock>): void => {
  ImapFlow.mockImplementation(() => client);
};

/**
 * Instancia el servicio con un `ConfigService` doblado.
 *
 * Se mockea y no se usa el real sembrado porque `ConfigService.get()` da
 * prioridad a `process.env`: una variable `IMAP_PASSWORD` presente en la maquina
 * que ejecuta la suite haria pasar la prueba negativa por el motivo equivocado.
 */
const buildService = (
  env: Record<string, string> = { [PASSWORD_ENV_KEY]: IMAP_PASSWORD },
): { service: WizardService; get: jest.Mock } => {
  const get = jest.fn((key: string) => env[key]);

  return {
    service: new WizardService({ get } as unknown as ConfigService),
    get,
  };
};

describe('WizardService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useClient(buildClient());
  });

  describe('1. Comprobacion correcta', () => {
    it('1.1 deberia devolver exito con el mensaje de confirmacion', async () => {
      // 1. Arrange
      const { service } = buildService();

      // 2. Act
      const result = await service.checkImap(buildDto());

      // 3. Assert
      expect(result).toEqual({
        success: true,
        message: CHECK_IMAP_SUCCESS_MESSAGE,
      });
    });

    it('1.2 deberia comprobar tambien que el buzon existe, no solo el login', async () => {
      // 1. Arrange
      const client = buildClient();
      useClient(client);
      const { service } = buildService();

      // 2. Act
      await service.checkImap(buildDto({ mailbox: 'Archivo' }));

      // 3. Assert: autenticar contra un buzon inexistente seria un falso
      //    positivo que el operador descubriria en la primera ejecucion.
      expect(client.connect).toHaveBeenCalledTimes(1);
      expect(client.status).toHaveBeenCalledWith('Archivo', {
        messages: true,
      });
    });

    it('1.3 deberia resolver la credencial con la clave declarada', async () => {
      // 1. Arrange
      const { service, get } = buildService({
        IMAP_NOTIWEB_PASSWORD: 'otra-clave',
      });

      // 2. Act
      const result = await service.checkImap(
        buildDto({ passwordEnvKey: 'IMAP_NOTIWEB_PASSWORD' }),
      );

      // 3. Assert
      expect(result.success).toBe(true);
      expect(get).toHaveBeenCalledWith('IMAP_NOTIWEB_PASSWORD');
    });

    it('1.4 deberia cerrar la sesion IMAP siempre', async () => {
      // 1. Arrange
      const client = buildClient();
      useClient(client);
      const { service } = buildService();

      // 2. Act
      await service.checkImap(buildDto());

      // 3. Assert
      expect(client.logout).toHaveBeenCalledTimes(1);
    });
  });

  describe('2. Fallos con severidad GRAVE', () => {
    it('2.1 deberia informar GRAVE sin conectar si la variable no existe', async () => {
      // 1. Arrange
      const { service } = buildService({});

      // 2. Act
      const result = await service.checkImap(buildDto());

      // 3. Assert: guarda previa a cualquier socket.
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.message).toContain(PASSWORD_ENV_KEY);
      expect(ImapFlow).not.toHaveBeenCalled();
    });

    it('2.2 deberia informar GRAVE si la variable esta vacia', async () => {
      // 1. Arrange
      const { service } = buildService({ [PASSWORD_ENV_KEY]: '' });

      // 2. Act
      const result = await service.checkImap(buildDto());

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(ImapFlow).not.toHaveBeenCalled();
    });

    it('2.3 deberia informar GRAVE ante credenciales invalidas', async () => {
      // 1. Arrange
      useClient(
        buildClient({
          connect: jest
            .fn()
            .mockRejectedValue(new Error('Invalid credentials')),
        }),
      );
      const { service } = buildService();

      // 2. Act
      const result = await service.checkImap(buildDto());

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.message).toContain('Invalid credentials');
    });

    it('2.4 deberia informar GRAVE si el buzon no existe', async () => {
      // 1. Arrange
      useClient(
        buildClient({
          status: jest.fn().mockRejectedValue(new Error('Mailbox not found')),
        }),
      );
      const { service } = buildService();

      // 2. Act
      const result = await service.checkImap(buildDto({ mailbox: 'Fantasma' }));

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Fantasma');
    });

    it('2.5 no deberia lanzar nunca: el fallo es una respuesta valida', async () => {
      // 1. Arrange
      useClient(
        buildClient({
          connect: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        }),
      );
      const { service } = buildService();

      // 2. Act & 3. Assert: un 4xx obligaria al cliente a distinguir "el
      //    servidor de correo rechazo las credenciales" de "la llamada fallo".
      await expect(service.checkImap(buildDto())).resolves.toMatchObject({
        success: false,
      });
    });

    it('2.6 deberia cerrar la sesion aunque la comprobacion falle', async () => {
      // 1. Arrange
      const client = buildClient({
        status: jest.fn().mockRejectedValue(new Error('Mailbox not found')),
      });
      useClient(client);
      const { service } = buildService();

      // 2. Act
      await service.checkImap(buildDto());

      // 3. Assert
      expect(client.logout).toHaveBeenCalledTimes(1);
    });
  });

  describe('3. No filtracion de secretos', () => {
    it('3.1 no deberia incluir la contrasena ni el stackTrace en la respuesta', async () => {
      // 1. Arrange
      useClient(
        buildClient({
          connect: jest
            .fn()
            .mockRejectedValue(new Error('Invalid credentials')),
        }),
      );
      const { service } = buildService();

      // 2. Act
      const result = await service.checkImap(buildDto());

      // 3. Assert: la traza revela rutas del servidor y no aporta nada a quien
      //    rellena un formulario; al `.log` fisico sigue yendo completa.
      expect(JSON.stringify(result)).not.toContain(IMAP_PASSWORD);
      expect(result.error).not.toHaveProperty('stackTrace');
    });

    it('3.2 deberia rechazar por DTO una passwordEnvKey que apunte a otro secreto', async () => {
      // 1. Arrange: intento de exfiltracion via el cuerpo de la peticion. Lo
      //    para el DTO en el ValidationPipe, antes de llegar al servicio.
      const dto = plainToInstance(ImapTriggerConfigDto, {
        host: 'imap.atacante.com',
        user: 'atacante',
        passwordEnvKey: 'JWT_SECRET',
      });

      // 2. Act
      const errors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });

      // 3. Assert
      expect(errors.map((error) => error.property)).toContain('passwordEnvKey');
    });

    it('3.3 deberia rechazar por DTO un cuerpo que traiga la contrasena en claro', async () => {
      // 1. Arrange
      const dto = plainToInstance(ImapTriggerConfigDto, {
        host: 'imap.unuware.com',
        user: 'notiweb@unuware.com',
        passwordEnvKey: PASSWORD_ENV_KEY,
        password: 'secreto-en-el-cuerpo',
      });

      // 2. Act
      const errors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });

      // 3. Assert: `forbidNonWhitelisted` lo RECHAZA en vez de descartarlo en
      //    silencio, que es lo que haria el pipe global de `main.ts`.
      expect(errors.map((error) => error.property)).toContain('password');
    });
  });
});
