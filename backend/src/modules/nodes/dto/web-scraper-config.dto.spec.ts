import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  DEFAULT_SCRAPER_MAX_RETRIES,
  MAX_EXCLUDED_DOMAINS,
  DEFAULT_SCRAPER_RETRY_DELAY_MS,
  DEFAULT_SCRAPER_IGNORE_EXTRACTION_FAILURE,
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

  describe('ignoreExtractionFailure', () => {
    it('deberia admitir la ausencia del campo', async () => {
      // 1. Arrange 📐: igual que sus hermanos, es opcional al guardar.
      const params = {};

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(0);
    });

    it('deberia admitir un booleano explicito', async () => {
      // 1. Arrange 📐
      const params = { ignoreExtractionFailure: false };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(0);
    });

    it('deberia rechazar un valor que no sea booleano', async () => {
      // 1. Arrange 📐: el `pipeline_schema` es `jsonb` y pudo escribirse por
      //    SQL directo, de modo que el "si" textual es alcanzable.
      const params = { ignoreExtractionFailure: 'si' };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('ignoreExtractionFailure');
      expect(Object.values(errors[0].constraints ?? {})).toContain(
        'ignoreExtractionFailure debe ser un booleano.',
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
        ignoreExtractionFailure: DEFAULT_SCRAPER_IGNORE_EXTRACTION_FAILURE,
        excludedDomains: [],
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

    it('deberia respetar un ignoreExtractionFailure desactivado explicitamente', () => {
      // 1. Arrange 📐: `?? ` y no `||`, para que `false` no caiga al defecto.
      //    Es el operador que SI quiere que el fallo pause la FSM.
      const dto = plainToInstance(WebScraperConfigDto, {
        ignoreExtractionFailure: false,
      });

      // 2. Act ⚙️
      const config = resolveWebScraperConfig(dto);

      // 3. Assert 🎯
      expect(config.ignoreExtractionFailure).toBe(false);
    });
  });

  /**
   * El filtro que impide raspar el portal institucional propio.
   *
   * Se valida la FORMA —solo el host— porque la comparacion se hace contra
   * `url.hostname`: un valor con esquema o ruta no coincidiria jamas y
   * produciria un filtro silenciosamente inerte, que es peor que un 400.
   */
  describe('excludedDomains', () => {
    it('deberia admitir la ausencia del campo', async () => {
      // 1. Arrange 📐: el defecto es la lista vacia; el backend no cablea
      //    ningun dominio de ningun cliente.
      const params = {};

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(0);
    });

    it('deberia admitir una lista de hosts', async () => {
      // 1. Arrange 📐
      const params = {
        excludedDomains: ['madrimasd.org', 'www.madrimasd.org'],
      };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(0);
    });

    it.each([
      'https://madrimasd.org',
      'madrimasd.org/portal-contratante',
      'madrimasd.org:443',
      ' madrimasd.org ',
      'madrimasd.org.',
      'madrimasd',
    ])('deberia rechazar %p por no ser solo el host', async (domain) => {
      // 1. Arrange 📐: el operador se entera al GUARDAR, con un mensaje de
      //    campo, en vez de descubrir en produccion que el filtro no filtraba.
      const params = { excludedDomains: [domain] };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('excludedDomains');
    });

    it('deberia rechazar una lista mas larga que el tope', async () => {
      // 1. Arrange 📐: el tope es de diagnostico, no tecnico. Ver el TSDoc.
      const params = {
        excludedDomains: Array.from(
          { length: MAX_EXCLUDED_DOMAINS + 1 },
          (_, index) => `portal-${index}.example`,
        ),
      };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(1);
      expect(Object.values(errors[0].constraints ?? {})).toContain(
        `excludedDomains no puede superar ${MAX_EXCLUDED_DOMAINS} entradas.`,
      );
    });

    it('deberia rechazar un elemento que no sea cadena', async () => {
      // 1. Arrange 📐: `pipeline_schema` es `jsonb` y pudo escribirse por SQL.
      const params = { excludedDomains: [42] };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('excludedDomains');
    });

    it('deberia pasar a minusculas y deduplicar al resolver', () => {
      // 1. Arrange 📐: `url.hostname` llega en minusculas, asi que la
      //    conversion se hace una vez y no en cada comparacion.
      const dto = plainToInstance(WebScraperConfigDto, {
        excludedDomains: ['MadrimasD.ORG', 'madrimasd.org', 'Otro.example'],
      });

      // 2. Act ⚙️
      const config = resolveWebScraperConfig(dto);

      // 3. Assert 🎯
      expect(config.excludedDomains).toEqual(['madrimasd.org', 'otro.example']);
    });
  });
});
