import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  DEFAULT_SCRAPER_MAX_RETRIES,
  DEFAULT_SCRAPER_RETRY_DELAY_MS,
  DEFAULT_SCRAPER_SKIP_IF_EMPTY,
  DEFAULT_SCRAPER_TIMEOUT_MS,
  WebScraperConfigDto,
  resolveWebScraperConfig,
} from './web-scraper-config.dto';

import type { ValidatorOptions } from 'class-validator';

/** Las mismas que aplica la estrategia: un campo de mas es un fallo. */
const VALIDATION_OPTIONS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

const validateParams = (params: Record<string, unknown>) =>
  validate(plainToInstance(WebScraperConfigDto, params), VALIDATION_OPTIONS);

describe('WebScraperConfigDto', () => {
  describe('skipIfEmpty', () => {
    it('deberia admitir la ausencia del campo', async () => {
      // 1. Arrange 📐: una plantilla de flujo declara topologia, no operativa.
      const params = {};

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(0);
    });

    it('deberia admitir un booleano explicito', async () => {
      // 1. Arrange 📐
      const params = { skipIfEmpty: false };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(0);
    });

    it('deberia rechazar un valor que no sea booleano', async () => {
      // 1. Arrange 📐: el `pipeline_schema` es una columna `jsonb` y pudo
      //    escribirse por SQL directo, asi que el "si" textual es alcanzable.
      const params = { skipIfEmpty: 'si' };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('skipIfEmpty');
      expect(Object.values(errors[0].constraints ?? {})).toContain(
        'skipIfEmpty debe ser un booleano.',
      );
    });
  });

  describe('resolveWebScraperConfig', () => {
    it('deberia aplicar los defectos sobre un DTO vacio', () => {
      // 1. Arrange 📐
      const dto = plainToInstance(WebScraperConfigDto, {});

      // 2. Act ⚙️
      const config = resolveWebScraperConfig(dto);

      // 3. Assert 🎯
      expect(config).toEqual({
        targetUrl: '',
        timeoutMs: DEFAULT_SCRAPER_TIMEOUT_MS,
        maxRetries: DEFAULT_SCRAPER_MAX_RETRIES,
        retryDelayMs: DEFAULT_SCRAPER_RETRY_DELAY_MS,
        skipIfEmpty: DEFAULT_SCRAPER_SKIP_IF_EMPTY,
      });
    });

    it('deberia respetar un skipIfEmpty desactivado explicitamente', () => {
      // 1. Arrange 📐: `?? ` y no `||`, para que `false` no caiga al defecto.
      const dto = plainToInstance(WebScraperConfigDto, { skipIfEmpty: false });

      // 2. Act ⚙️
      const config = resolveWebScraperConfig(dto);

      // 3. Assert 🎯
      expect(config.skipIfEmpty).toBe(false);
    });
  });
});
