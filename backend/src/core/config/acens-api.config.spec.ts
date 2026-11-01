import { DEFAULT_HTTP_TIMEOUT_MS } from '@core/http/http-client.service';

import {
  ACENS_API_BASE_URL_VAR,
  ACENS_API_KEY_VAR,
  ACENS_API_TIMEOUT_MS_VAR,
  AcensApiConfig,
} from './acens-api.config';

import type { ConfigService } from '@nestjs/config';

/** Entorno simulado: un mapa de variable a valor. */
const buildConfig = (env: Record<string, string> = {}): AcensApiConfig =>
  new AcensApiConfig({
    get: jest.fn((variable: string) => env[variable]),
  } as unknown as ConfigService);

const VALID_ENV = {
  [ACENS_API_BASE_URL_VAR]: 'https://api.acens.com/v1/',
  [ACENS_API_KEY_VAR]: ' clave-acens ',
};

describe('AcensApiConfig', () => {
  it('1.1 deberia recortar la barra final de la raiz y los espacios de la clave', () => {
    // 1. Arrange 📐
    const config = buildConfig(VALID_ENV);

    // 2. Act ⚙️ + 3. Assert 🎯
    expect(config.baseUrl).toBe('https://api.acens.com/v1');
    expect(config.apiKey).toBe('clave-acens');
    expect(config.authHeader).toBe('Bearer clave-acens');
    expect(config.isUsable).toBe(true);
  });

  it('1.2 no deberia ser utilizable sin raiz, sin clave o con raiz http', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(buildConfig().isUsable).toBe(false);
    expect(
      buildConfig({ [ACENS_API_BASE_URL_VAR]: 'https://api.acens.com/v1' })
        .isUsable,
    ).toBe(false);
    expect(
      buildConfig({
        ...VALID_ENV,
        [ACENS_API_BASE_URL_VAR]: 'http://api.acens.com/v1',
      }).isUsable,
    ).toBe(false);
  });

  it('1.3 deberia caer al timeout por defecto ante un valor no numerico', () => {
    // 1. Arrange 📐
    const broken = buildConfig({ [ACENS_API_TIMEOUT_MS_VAR]: 'diez' });
    const declared = buildConfig({ [ACENS_API_TIMEOUT_MS_VAR]: '8000' });

    // 2. Act ⚙️ + 3. Assert 🎯
    expect(broken.timeoutMs).toBe(DEFAULT_HTTP_TIMEOUT_MS);
    expect(declared.timeoutMs).toBe(8000);
  });
});
