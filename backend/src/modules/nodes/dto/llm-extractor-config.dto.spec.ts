import {
  DEFAULT_LLM_MAX_RETRIES,
  DEFAULT_LLM_TIMEOUT_MS,
  LLM_RETRY_BASE_DELAY_MS,
  LlmExtractorConfigDto,
  MAX_LLM_RETRIES,
  MAX_LLM_TIMEOUT_MS,
  MIN_LLM_TIMEOUT_MS,
  resolveLlmExtractorConfig,
} from './llm-extractor-config.dto';

import type { AiHttpDefaults } from '@core/config/ai-defaults.config';

/** Entorno que no declara nada: el escenario de un `.env` sin estas variables. */
const SIN_ENTORNO: AiHttpDefaults = { timeoutMs: null, maxRetries: null };

/** DTO ya validado, construido a mano por ser una funcion pura la que se mide. */
const buildDto = (
  overrides: Partial<LlmExtractorConfigDto> = {},
): LlmExtractorConfigDto =>
  Object.assign(new LlmExtractorConfigDto(), overrides);

describe('resolveLlmExtractorConfig · politica de red', () => {
  describe('1. Precedencia: params del nodo > entorno > constante', () => {
    it('1.1 deberia caer en las constantes cuando nadie declara nada', () => {
      // 1. Arrange 📐: es el comportamiento que tenia el nodo antes de que
      //    existieran las variables `LLM_HTTP_*`, y hay que conservarlo: una
      //    plantilla de flujo guarda sus `params` vacios a proposito.
      const dto = buildDto();

      // 2. Act ⚙️
      const config = resolveLlmExtractorConfig(dto, SIN_ENTORNO);

      // 3. Assert 🎯
      expect(config.timeoutMs).toBe(DEFAULT_LLM_TIMEOUT_MS);
      expect(config.maxRetries).toBe(DEFAULT_LLM_MAX_RETRIES);
    });

    it('1.2 deberia preferir el entorno a la constante', () => {
      // 1. Arrange 📐: el escalon intermedio. Es lo que permite alargar la
      //    espera sin desplegar, que es el motivo de toda esta tanda.
      const dto = buildDto();

      // 2. Act ⚙️
      const config = resolveLlmExtractorConfig(dto, {
        timeoutMs: 60_000,
        maxRetries: 2,
      });

      // 3. Assert 🎯
      expect(config.timeoutMs).toBe(60_000);
      expect(config.maxRetries).toBe(2);
    });

    it('1.3 deberia preferir los params del nodo al entorno', () => {
      // 1. Arrange 📐: el entorno es el ULTIMO escalon, no el primero. Un nodo
      //    que declara su espera manda sobre el `.env`, igual que ya ocurre con
      //    el proveedor y el modelo.
      const dto = buildDto({ timeoutMs: 20_000, maxRetries: 0 });

      // 2. Act ⚙️
      const config = resolveLlmExtractorConfig(dto, {
        timeoutMs: 90_000,
        maxRetries: 4,
      });

      // 3. Assert 🎯
      expect(config.timeoutMs).toBe(20_000);
      expect(config.maxRetries).toBe(0);
    });

    it('1.4 deberia seguir siendo invocable sin entorno', () => {
      // 1. Arrange 📐: el segundo parametro lleva valor por defecto para que los
      //    llamantes que no tienen entorno que consultar —validadores,
      //    asistente— no tengan que inventarse uno.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(resolveLlmExtractorConfig(buildDto()).timeoutMs).toBe(
        DEFAULT_LLM_TIMEOUT_MS,
      );
    });
  });

  describe('2. Recorte del valor que llega del entorno', () => {
    it('2.1 deberia recortar una espera desmesurada al techo del nodo', () => {
      // 1. Arrange 📐: una variable del `.env` NO atraviesa `class-validator`,
      //    asi que los `@Min`/`@Max` del DTO no la alcanzan y llegaria intacta
      //    hasta Axios. Se recorta y no se rechaza porque una errata en el
      //    `.env` no debe impedir que el flujo corra.
      const dto = buildDto();

      // 2. Act ⚙️
      const config = resolveLlmExtractorConfig(dto, {
        timeoutMs: 999_999_999,
        maxRetries: 99,
      });

      // 3. Assert 🎯
      expect(config.timeoutMs).toBe(MAX_LLM_TIMEOUT_MS);
      expect(config.maxRetries).toBe(MAX_LLM_RETRIES);
    });

    it('2.2 deberia recortar una espera irrisoria al suelo del nodo', () => {
      // 1. Arrange 📐: por debajo de un segundo ningun proveedor termina de
      //    generar nada, y el nodo se pasaria la vida devolviendo timeouts
      //    contra un servicio que funciona.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(
        resolveLlmExtractorConfig(buildDto(), {
          timeoutMs: 5,
          maxRetries: null,
        }).timeoutMs,
      ).toBe(MIN_LLM_TIMEOUT_MS);
    });
  });

  describe('3. Espera base entre reintentos', () => {
    it('3.1 deberia resolver siempre la constante, sin campo en el DTO', () => {
      // 1. Arrange 📐: no es una decision del operador sino la distancia minima
      //    que el proveedor necesita entre dos intentos. Los 500 ms por defecto
      //    del cliente HTTP garantizan caer en el mismo 429 de cuota.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(
        resolveLlmExtractorConfig(buildDto(), SIN_ENTORNO).baseDelayMs,
      ).toBe(LLM_RETRY_BASE_DELAY_MS);
      expect(LLM_RETRY_BASE_DELAY_MS).toBeGreaterThanOrEqual(2_500);
    });
  });
});
