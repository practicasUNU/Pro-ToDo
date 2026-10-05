import {
  DEFAULT_DRUPAL_API_BASE_URL,
  DRUPAL_API_BASE_URL_VAR,
  DRUPAL_API_TIMEOUT_MS_VAR,
  DRUPAL_API_TOKEN_VAR,
  DRUPAL_API_USER_VAR,
  DRUPAL_AUTH_TYPE_VAR,
  DrupalApiConfig,
} from './drupal-api.config';

import type { ConfigService } from '@nestjs/config';

/** Entorno simulado: un mapa de variable a valor. */
const buildConfigService = (env: Record<string, string>): ConfigService =>
  ({
    get: jest.fn((variable: string) => env[variable]),
  }) as unknown as ConfigService;

const buildConfig = (env: Record<string, string> = {}): DrupalApiConfig =>
  new DrupalApiConfig(buildConfigService(env));

/** Credenciales validas de modo BASIC, que es el camino por defecto. */
const BASIC_ENV = {
  [DRUPAL_API_USER_VAR]: 'editor_api',
  [DRUPAL_API_TOKEN_VAR]: 'clave-secreta',
};

/** `editor_api:clave-secreta` en Base64, calculado fuera de la clase probada. */
const EXPECTED_BASIC = 'Basic ZWRpdG9yX2FwaTpjbGF2ZS1zZWNyZXRh';

describe('DrupalApiConfig', () => {
  describe('1. Esquema de autenticacion', () => {
    it('1.1 deberia usar BASIC cuando el entorno no declara el esquema', () => {
      // 1. Arrange 📐: el defecto NO es neutro, es una apuesta. La instalacion
      //    de Madrid+D monta el modulo `basic_auth` del nucleo y no
      //    `simple_oauth`, asi que BASIC es lo unico que autentica alli.
      const config = buildConfig(BASIC_ENV);

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(config.authType).toBe('BASIC');
      expect(config.authHeader).toBe(EXPECTED_BASIC);
    });

    it('1.2 deberia componer la cabecera Basic con el Base64 de usuario:clave', () => {
      // 1. Arrange 📐: el literal esperado se calculo aparte a proposito. Si se
      //    derivara aqui con el mismo `Buffer.from` que usa la clase, la prueba
      //    repetiria la implementacion en vez de fijar el formato.
      const config = buildConfig(BASIC_ENV);

      // 3. Assert 🎯
      expect(config.authHeader).toBe(EXPECTED_BASIC);
      expect(
        Buffer.from(
          config.authHeader.replace('Basic ', ''),
          'base64',
        ).toString(),
      ).toBe('editor_api:clave-secreta');
    });

    it('1.3 deberia emitir Bearer cuando el entorno lo pide explicitamente', () => {
      // 1. Arrange 📐
      const config = buildConfig({
        ...BASIC_ENV,
        [DRUPAL_AUTH_TYPE_VAR]: 'BEARER',
      });

      // 3. Assert 🎯: el usuario sigue declarado y aun asi NO entra en la
      //    cabecera. Bajo OAuth la cuenta la identifica el propio token.
      expect(config.authType).toBe('BEARER');
      expect(config.authHeader).toBe('Bearer clave-secreta');
    });

    it('1.4 deberia aceptar el esquema en minusculas', () => {
      // 1. Arrange 📐: el `.env` se escribe a mano y `bearer` es la misma
      //    intencion que `BEARER`. Distinguirlos solo produce fallos mudos.
      const config = buildConfig({
        ...BASIC_ENV,
        [DRUPAL_AUTH_TYPE_VAR]: 'bearer',
      });

      // 3. Assert 🎯
      expect(config.authType).toBe('BEARER');
    });

    it('1.5 deberia caer a BASIC ante un esquema no reconocido', () => {
      // 1. Arrange 📐: una errata en el `.env` no debe tumbar el nodo, y de las
      //    dos opciones BASIC es la que funciona contra la instalacion real.
      const config = buildConfig({
        ...BASIC_ENV,
        [DRUPAL_AUTH_TYPE_VAR]: 'OAUTH2',
      });

      // 3. Assert 🎯
      expect(config.authType).toBe('BASIC');
      expect(config.authHeader).toBe(EXPECTED_BASIC);
    });

    it('1.6 deberia caer a Bearer si falta el usuario pese a pedir BASIC', () => {
      // 1. Arrange 📐: sin usuario, un `Basic` de `:clave` es una credencial
      //    invalida que Drupal procesa como ANONIMA. Degradar a Bearer deja al
      //    menos una cabecera bien formada; de rechazar la ejecucion ya se
      //    encarga `isUsable`, que es quien devuelve ERR_DRUPAL_CONFIG.
      const config = buildConfig({ [DRUPAL_API_TOKEN_VAR]: 'clave-secreta' });

      // 3. Assert 🎯
      expect(config.authHeader).toBe('Bearer clave-secreta');
      expect(config.authHeader).not.toContain('Basic');
    });
  });

  describe('2. Suficiencia de credenciales (isUsable)', () => {
    it('2.1 deberia aceptar un BASIC con usuario y clave', () => {
      expect(buildConfig(BASIC_ENV).isUsable).toBe(true);
    });

    it('2.2 deberia RECHAZAR un BASIC sin usuario', () => {
      // 1. Arrange 📐: es el fallo que motivo esta variante. Sin esta guarda la
      //    peticion sale, Drupal la evalua como anonima y el sintoma llega como
      //    ERR_DRUPAL_AUTH —que apunta al servidor— en vez de como
      //    ERR_DRUPAL_CONFIG, que apunta al `.env`, que es donde esta el fallo.
      const config = buildConfig({ [DRUPAL_API_TOKEN_VAR]: 'clave-secreta' });

      // 3. Assert 🎯
      expect(config.isUsable).toBe(false);
    });

    it('2.3 deberia aceptar un BEARER sin usuario', () => {
      // 1. Arrange 📐: bajo OAuth el usuario no pinta nada, asi que exigirlo
      //    bloquearia una configuracion perfectamente valida.
      const config = buildConfig({
        [DRUPAL_API_TOKEN_VAR]: 'clave-secreta',
        [DRUPAL_AUTH_TYPE_VAR]: 'BEARER',
      });

      // 3. Assert 🎯
      expect(config.isUsable).toBe(true);
    });

    it('2.4 deberia RECHAZAR cualquier esquema sin credencial', () => {
      expect(
        buildConfig({ [DRUPAL_API_USER_VAR]: 'editor_api' }).isUsable,
      ).toBe(false);
      expect(
        buildConfig({
          [DRUPAL_API_USER_VAR]: 'editor_api',
          [DRUPAL_AUTH_TYPE_VAR]: 'BEARER',
        }).isUsable,
      ).toBe(false);
    });
  });

  describe('3. Destino y espera', () => {
    it('3.1 deberia recortar la barra final de la raiz', () => {
      // 1. Arrange 📐: las rutas se concatenan con `/` delante, de modo que una
      //    barra sobrante produce `//node/page` y un 404 del enrutador.
      const config = buildConfig({
        [DRUPAL_API_BASE_URL_VAR]: 'https://cms.example/jsonapi/',
      });

      // 3. Assert 🎯
      expect(config.baseUrl).toBe('https://cms.example/jsonapi');
    });

    it('3.2 deberia caer al portal institucional si la raiz viene vacia', () => {
      expect(buildConfig({ [DRUPAL_API_BASE_URL_VAR]: '  ' }).baseUrl).toBe(
        DEFAULT_DRUPAL_API_BASE_URL,
      );
    });

    it('3.3 deberia ignorar una espera no numerica en vez de propagarla', () => {
      // 1. Arrange 📐: un `timeout: NaN` deja la peticion colgada para siempre,
      //    que es estrictamente peor que ignorar una variable mal escrita.
      const config = buildConfig({ [DRUPAL_API_TIMEOUT_MS_VAR]: 'quince mil' });

      // 3. Assert 🎯
      expect(config.timeoutMs).toBe(15_000);
    });
  });
});
