import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import {
  DEFAULT_OCR_MAX_RETRIES,
  DEFAULT_OCR_TIMEOUT_MS,
  MAX_OCR_CUSTOM_PROMPT_LENGTH,
  MAX_OCR_RETRIES,
  MAX_OCR_TIMEOUT_MS,
  MIN_OCR_TIMEOUT_MS,
  OCR_RETRY_BASE_DELAY_MS,
  OcrProcessorConfigDto,
  PROMPT_OCR_MULTIMODAL,
  resolveOcrProcessorConfig,
} from './ocr-processor-config.dto';

import type { AiHttpDefaults } from '@core/config/ai-defaults.config';

/** Entorno que no declara nada: ni piso ni techo. */
const SIN_ENTORNO: AiHttpDefaults = { timeoutMs: null, maxRetries: null };

/** DTO ya validado: lo que se mide es la funcion pura que viene despues. */
const buildDto = (
  overrides: Partial<OcrProcessorConfigDto> = {},
): OcrProcessorConfigDto =>
  Object.assign(new OcrProcessorConfigDto(), overrides);

describe('resolveOcrProcessorConfig · politica de red', () => {
  describe('1. El entorno como piso y techo', () => {
    it('1.1 deberia caer en las constantes cuando nadie declara nada', () => {
      // 1. Arrange 📐: una plantilla de flujo guarda sus `params` vacios a
      //    proposito, asi que este es un escenario corriente y no un borde.
      // 2. Act ⚙️
      const config = resolveOcrProcessorConfig(buildDto(), SIN_ENTORNO);

      // 3. Assert 🎯
      expect(config.timeoutMs).toBe(DEFAULT_OCR_TIMEOUT_MS);
      expect(config.maxRetries).toBe(DEFAULT_OCR_MAX_RETRIES);
    });

    it('1.2 deberia ELEVAR la espera que el flujo trae guardada', () => {
      // 1. Arrange 📐: el store de este nodo tambien publica `timeoutMs` al
      //    guardar, de modo que sin el piso `OCR_HTTP_TIMEOUT_MS` no alcanzaria
      //    a ningun flujo ya configurado — el mismo agujero que el nodo de
      //    redaccion.
      const dto = buildDto({ timeoutMs: 20_000 });

      // 2. Act ⚙️
      const config = resolveOcrProcessorConfig(dto, {
        timeoutMs: 45_000,
        maxRetries: null,
      });

      // 3. Assert 🎯
      expect(config.timeoutMs).toBe(45_000);
    });

    it('1.3 deberia RECORTAR los reintentos que el flujo trae guardados', () => {
      // 1. Arrange 📐: al reves que la espera, porque el riesgo cambia de lado:
      //    los reintentos se multiplican por la cadena de respaldo y cada
      //    vuelta factura tokens.
      const dto = buildDto({ maxRetries: 5 });

      // 2. Act ⚙️
      const config = resolveOcrProcessorConfig(dto, {
        timeoutMs: null,
        maxRetries: 1,
      });

      // 3. Assert 🎯
      expect(config.maxRetries).toBe(1);
    });

    it('1.4 sin variables declaradas NO deberia cambiar nada', () => {
      // 1. Arrange 📐: la guarda que hace inocuo el cambio donde no se declaren
      //    las variables.
      // `maxRetries: 3` es el techo del DTO desde que bajo de 5: sigue siendo
      // distinto del defecto (1), que es lo que esta prueba necesita para
      // demostrar que manda el nodo, y ademas no lo recorta el `clamp`.
      const dto = buildDto({ timeoutMs: 5_000, maxRetries: 3 });

      // 2. Act ⚙️
      const config = resolveOcrProcessorConfig(dto, SIN_ENTORNO);

      // 3. Assert 🎯
      expect(config.timeoutMs).toBe(5_000);
      expect(config.maxRetries).toBe(3);
    });
  });

  describe('2. Recorte del valor que llega del entorno', () => {
    it('2.1 deberia recortar al rango del nodo', () => {
      // 1. Arrange 📐: una variable del `.env` no atraviesa `class-validator`
      //    en ninguna parte, asi que los `@Min`/`@Max` del DTO no la alcanzan.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(
        resolveOcrProcessorConfig(buildDto(), {
          timeoutMs: 999_999_999,
          maxRetries: 99,
        }).timeoutMs,
      ).toBe(MAX_OCR_TIMEOUT_MS);
      expect(
        resolveOcrProcessorConfig(buildDto(), {
          timeoutMs: 999_999_999,
          maxRetries: 99,
        }).maxRetries,
      ).toBe(MAX_OCR_RETRIES);
      expect(
        resolveOcrProcessorConfig(buildDto(), {
          timeoutMs: 5,
          maxRetries: null,
        }).timeoutMs,
      ).toBe(MIN_OCR_TIMEOUT_MS);
    });
  });

  describe('3. Espera base entre reintentos', () => {
    it('3.1 deberia resolver siempre la constante, sin campo en el DTO', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(
        resolveOcrProcessorConfig(buildDto(), SIN_ENTORNO).baseDelayMs,
      ).toBe(OCR_RETRY_BASE_DELAY_MS);
    });
  });
});

describe('resolveOcrProcessorConfig · prompt de transcripcion', () => {
  it('4.1 deberia usar PROMPT_OCR_MULTIMODAL si el nodo no declara customPrompt', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const config = resolveOcrProcessorConfig(buildDto(), SIN_ENTORNO);

    // 3. Assert 🎯
    expect(config.prompt).toBe(PROMPT_OCR_MULTIMODAL);
  });

  it('4.2 deberia usar el customPrompt recortado y tratar uno en blanco como ausente', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const custom = resolveOcrProcessorConfig(
      buildDto({ customPrompt: '  Solo la primera pagina.  ' }),
      SIN_ENTORNO,
    );
    const blank = resolveOcrProcessorConfig(
      buildDto({ customPrompt: '   ' }),
      SIN_ENTORNO,
    );

    // 3. Assert 🎯
    expect(custom.prompt).toBe('Solo la primera pagina.');
    expect(blank.prompt).toBe(PROMPT_OCR_MULTIMODAL);
  });

  it('4.3 deberia rechazar un customPrompt por encima del techo', () => {
    // 1. Arrange 📐
    const dto = plainToInstance(OcrProcessorConfigDto, {
      customPrompt: 'x'.repeat(MAX_OCR_CUSTOM_PROMPT_LENGTH + 1),
    });

    // 2. Act ⚙️
    const errors = validateSync(dto);

    // 3. Assert 🎯
    expect(errors.map((error) => error.property)).toEqual(['customPrompt']);
  });
});
