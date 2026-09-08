import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_IMAP_PORT,
  DEFAULT_MAILBOX,
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  useTriggerImapStore,
} from './trigger-imap.store';

import type { TriggerImapConfig } from './trigger-imap.store';
import type { CheckImapResult } from '@/types/pipeline';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/nodes/trigger-imap.service', () => ({
  checkImapConnection: vi.fn(),
}));

const triggerImapService = await import('@services/nodes/trigger-imap.service');
const checkImapConnection = vi.mocked(triggerImapService.checkImapConnection);

const VALID_HOST = 'imap.unuware.com';
const VALID_USER = 'notiweb@unuware.com';
const VALID_ENV_KEY = 'IMAP_PASSWORD';

/** Configuracion completa y admisible; cada prueba altera lo que le concierne. */
const VALID_CONFIG: Partial<TriggerImapConfig> = {
  host: VALID_HOST,
  user: VALID_USER,
  passwordEnvKey: VALID_ENV_KEY,
};

const SUCCESS_RESULT: CheckImapResult = {
  success: true,
  message: 'Conexión exitosa',
};

const FAILURE_RESULT: CheckImapResult = {
  success: false,
  error: { level: 'GRAVE', message: 'Invalid credentials' },
};

/** Store con los campos completos y la conexion YA verificada. */
const buildVerifiedStore = (): ReturnType<typeof useTriggerImapStore> => {
  const store = useTriggerImapStore();
  store.patchConfig(VALID_CONFIG);
  store.connectionVerified = true;

  return store;
};

describe('useTriggerImapStore · configuracion del nodo TRIGGER_IMAP', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  describe('1. Valores por defecto', () => {
    it('1.1 deberia replicar los defaults del DTO backend', () => {
      // 1. Arrange & 2. Act
      const store = useTriggerImapStore();

      // 3. Assert
      expect(store.config).toEqual({
        host: '',
        port: DEFAULT_IMAP_PORT,
        secure: true,
        user: '',
        passwordEnvKey: '',
        mailbox: DEFAULT_MAILBOX,
        pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      });
      expect(DEFAULT_IMAP_PORT).toBe(993);
      expect(DEFAULT_MAILBOX).toBe('INBOX');
      expect(DEFAULT_POLL_INTERVAL_MS).toBe(60_000);
    });

    it('1.2 deberia arrancar sin verificar y sin resultado previo', () => {
      // 1. Arrange & 2. Act
      const store = useTriggerImapStore();

      // 3. Assert
      expect(store.connectionVerified).toBe(false);
      expect(store.lastCheckResult).toBeNull();
      expect(store.isConfigValid).toBe(false);
    });
  });

  describe('2. Validacion de campos', () => {
    it('2.1 deberia invalidar si falta el host', () => {
      // 1. Arrange
      const store = useTriggerImapStore();

      // 2. Act
      store.patchConfig({ ...VALID_CONFIG, host: '   ' });

      // 3. Assert: espacios en blanco no cuentan como host.
      expect(store.hasValidFields).toBe(false);
    });

    it('2.2 deberia invalidar si falta el usuario', () => {
      // 1. Arrange
      const store = useTriggerImapStore();

      // 2. Act
      store.patchConfig({ ...VALID_CONFIG, user: '' });

      // 3. Assert
      expect(store.hasValidFields).toBe(false);
    });

    it('2.3 deberia invalidar si el buzon esta vacio', () => {
      // 1. Arrange
      const store = useTriggerImapStore();

      // 2. Act
      store.patchConfig({ ...VALID_CONFIG, mailbox: '' });

      // 3. Assert
      expect(store.hasValidFields).toBe(false);
    });

    it('2.4 deberia rechazar una passwordEnvKey fuera del patron', () => {
      // 1. Arrange: intento de apuntar a otro secreto del entorno.
      const store = useTriggerImapStore();

      // 2. Act & 3. Assert: el patron acota lo que el nodo puede leer del
      //    entorno a credenciales de correo.
      for (const envKey of [
        'JWT_SECRET',
        'MI_PASSWORD',
        'IMAP_TOKEN',
        'imap_password',
        'DB_PASSWORD',
      ]) {
        store.patchConfig({ ...VALID_CONFIG, passwordEnvKey: envKey });
        expect(store.hasValidFields).toBe(false);
      }
    });

    it('2.5 deberia aceptar las claves IMAP_*PASSWORD legitimas', () => {
      // 1. Arrange
      const store = useTriggerImapStore();

      // 2. Act & 3. Assert
      for (const envKey of ['IMAP_PASSWORD', 'IMAP_NOTIWEB_PASSWORD']) {
        store.patchConfig({ ...VALID_CONFIG, passwordEnvKey: envKey });
        expect(store.hasValidFields).toBe(true);
      }
    });

    it('2.6 deberia rechazar un pollIntervalMs bajo el minimo del backend', () => {
      // 1. Arrange
      const store = useTriggerImapStore();

      // 2. Act
      store.patchConfig({ ...VALID_CONFIG, pollIntervalMs: 1_000 });

      // 3. Assert: sin esta regla el formulario dejaria enviar un valor que el
      //    backend devuelve como 400.
      expect(store.hasValidFields).toBe(false);

      // 2. Act (limite exacto)
      store.patchConfig({ pollIntervalMs: MIN_POLL_INTERVAL_MS });

      // 3. Assert
      expect(store.hasValidFields).toBe(true);
    });

    it('2.7 deberia rechazar un puerto fuera de rango', () => {
      // 1. Arrange
      const store = useTriggerImapStore();

      // 2. Act & 3. Assert
      store.patchConfig({ ...VALID_CONFIG, port: 0 });
      expect(store.hasValidFields).toBe(false);

      store.patchConfig({ port: 70_000 });
      expect(store.hasValidFields).toBe(false);

      store.patchConfig({ port: 993 });
      expect(store.hasValidFields).toBe(true);
    });
  });

  describe('3. Prueba de conexion', () => {
    it('3.1 deberia invocar al servicio con el payload recortado', async () => {
      // 1. Arrange
      const store = useTriggerImapStore();
      store.patchConfig({ ...VALID_CONFIG, host: '  imap.unuware.com  ' });
      checkImapConnection.mockResolvedValue(SUCCESS_RESULT);

      // 2. Act
      await store.testConnection();

      // 3. Assert: sin `password` en ningun caso, y con los espacios sobrantes
      //    ya eliminados para que no lleguen al servidor de correo.
      expect(checkImapConnection).toHaveBeenCalledWith({
        host: VALID_HOST,
        port: DEFAULT_IMAP_PORT,
        secure: true,
        user: VALID_USER,
        passwordEnvKey: VALID_ENV_KEY,
        mailbox: DEFAULT_MAILBOX,
        pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      });
      expect(checkImapConnection.mock.calls[0]?.[0]).not.toHaveProperty('password');
    });

    it('3.2 deberia habilitar isConfigValid tras una conexion correcta', async () => {
      // 1. Arrange
      const store = useTriggerImapStore();
      store.patchConfig(VALID_CONFIG);
      checkImapConnection.mockResolvedValue(SUCCESS_RESULT);

      // 2. Act
      await store.testConnection();

      // 3. Assert
      expect(store.connectionVerified).toBe(true);
      expect(store.isConfigValid).toBe(true);
      expect(store.lastCheckResult).toEqual(SUCCESS_RESULT);
    });

    it('3.3 no deberia habilitar isConfigValid si el backend responde success false', async () => {
      // 1. Arrange
      const store = useTriggerImapStore();
      store.patchConfig(VALID_CONFIG);
      checkImapConnection.mockResolvedValue(FAILURE_RESULT);

      // 2. Act
      await store.testConnection();

      // 3. Assert: un fallo de credenciales llega como 200, asi que hay que
      //    mirar el `success` del cuerpo y no solo el status.
      expect(store.connectionVerified).toBe(false);
      expect(store.isConfigValid).toBe(false);
      expect(store.lastCheckResult?.error?.level).toBe('GRAVE');
    });

    it('3.4 deberia mantener isConfigValid en false con campos completos pero sin probar', () => {
      // 1. Arrange & 2. Act
      const store = useTriggerImapStore();
      store.patchConfig(VALID_CONFIG);

      // 3. Assert: unas credenciales bien formadas pero equivocadas no fallarian
      //    hasta que el sondeo disparase el flujo en produccion.
      expect(store.hasValidFields).toBe(true);
      expect(store.isConfigValid).toBe(false);
    });

    it('3.5 deberia apagar isLoading aunque el servicio lance', async () => {
      // 1. Arrange
      const store = useTriggerImapStore();
      store.patchConfig(VALID_CONFIG);
      checkImapConnection.mockRejectedValue(new Error('Network Error'));

      // 2. Act & 3. Assert: la excepcion se propaga al componente, pero el
      //    `finally` deja el spinner apagado.
      await expect(store.testConnection()).rejects.toThrow('Network Error');
      expect(store.isLoading).toBe(false);
      expect(store.connectionVerified).toBe(false);
    });
  });

  describe('4. Invalidacion de la verificacion', () => {
    it('4.1 deberia invalidar la prueba al cambiar el host', () => {
      // 1. Arrange
      const store = buildVerifiedStore();
      expect(store.isConfigValid).toBe(true);

      // 2. Act
      store.patchConfig({ host: 'imap.atacante.com' });

      // 3. Assert: probar con un host correcto y cambiarlo despues dejaria
      //    avanzar con una configuracion que nunca se comprobo.
      expect(store.connectionVerified).toBe(false);
      expect(store.isConfigValid).toBe(false);
    });

    it('4.2 deberia invalidar la prueba al cambiar cualquier campo de conexion', () => {
      // 1. Arrange & 2. Act & 3. Assert
      const cases: Partial<TriggerImapConfig>[] = [
        { user: 'otro@unuware.com' },
        { passwordEnvKey: 'IMAP_NOTIWEB_PASSWORD' },
        { port: 143 },
        { secure: false },
        { mailbox: 'Archivo' },
        { pollIntervalMs: 120_000 },
      ];

      for (const patch of cases) {
        const store = buildVerifiedStore();
        store.patchConfig(patch);
        expect(store.connectionVerified).toBe(false);
      }
    });

    it('4.3 deberia descartar el resultado previo al cambiar la configuracion', () => {
      // 1. Arrange
      const store = buildVerifiedStore();
      store.lastCheckResult = SUCCESS_RESULT;

      // 2. Act
      store.patchConfig({ host: 'otro.host.com' });

      // 3. Assert: conservarlo mostraria un "Conexión exitosa" que ya no
      //    corresponde a lo que hay en el formulario.
      expect(store.lastCheckResult).toBeNull();
    });
  });

  describe('5. Reseteo', () => {
    it('5.1 deberia devolver el nodo a su estado inicial', () => {
      // 1. Arrange
      const store = buildVerifiedStore();
      store.lastCheckResult = SUCCESS_RESULT;

      // 2. Act
      store.resetConfig();

      // 3. Assert
      expect(store.config.host).toBe('');
      expect(store.config.port).toBe(DEFAULT_IMAP_PORT);
      expect(store.connectionVerified).toBe(false);
      expect(store.lastCheckResult).toBeNull();
      expect(store.isConfigValid).toBe(false);
    });
  });
});
