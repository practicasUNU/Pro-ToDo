import { Logger } from '@nestjs/common';

import {
  AI_DEFAULT_MODEL_VAR,
  AI_DEFAULT_PROVIDER_VAR,
  AI_OCR_DEFAULT_MODEL_VAR,
  AI_OCR_DEFAULT_PROVIDER_VAR,
  AiDefaultsConfig,
  LLM_HTTP_MAX_RETRIES_VAR,
  LLM_HTTP_TIMEOUT_MS_VAR,
  OCR_HTTP_MAX_RETRIES_VAR,
  OCR_HTTP_TIMEOUT_MS_VAR,
} from './ai-defaults.config';

import type { ConfigService } from '@nestjs/config';

/** Entorno simulado: un mapa de variable a valor. */
const buildConfigService = (env: Record<string, string>): ConfigService =>
  ({
    get: jest.fn((variable: string) => env[variable]),
  }) as unknown as ConfigService;

const buildResolver = (env: Record<string, string> = {}): AiDefaultsConfig =>
  new AiDefaultsConfig(buildConfigService(env));

describe('AiDefaultsConfig', () => {
  describe('1. Traduccion del vocabulario del .env', () => {
    it('1.1 deberia traducir los nombres comerciales al enum', () => {
      // 1. Arrange 📐: el `.env` se escribe a mano y usa minusculas, mientras
      //    que el contrato interno va en mayusculas. Un `toUpperCase()` acertaria
      //    con `anthropic` y fallaria justo con el valor que mas se usa aqui.
      const resolver = buildResolver({
        [AI_DEFAULT_PROVIDER_VAR]: 'anthropic',
        [AI_DEFAULT_MODEL_VAR]: 'claude-3-5-sonnet-20241022',
        [AI_OCR_DEFAULT_PROVIDER_VAR]: 'google_gemini',
        [AI_OCR_DEFAULT_MODEL_VAR]: 'gemini-3.6-flash',
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(resolver.getTextDefaults()).toEqual({
        provider: 'ANTHROPIC',
        model: 'claude-3-5-sonnet-20241022',
      });
      expect(resolver.getOcrDefaults()).toEqual({
        provider: 'GEMINI',
        model: 'gemini-3.6-flash',
      });
    });

    it('1.2 deberia admitir los alias corrientes de cada proveedor', () => {
      // 1. Arrange 📐: rechazar `gemini` porque la tabla dice `google_gemini`
      //    seria un rigor que solo produce incidencias de configuracion.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(
        buildResolver({ [AI_DEFAULT_PROVIDER_VAR]: 'gemini' }).getTextDefaults()
          .provider,
      ).toBe('GEMINI');
      expect(
        buildResolver({ [AI_DEFAULT_PROVIDER_VAR]: 'claude' }).getTextDefaults()
          .provider,
      ).toBe('ANTHROPIC');
      expect(
        buildResolver({
          [AI_DEFAULT_PROVIDER_VAR]: 'CHATGPT',
        }).getTextDefaults().provider,
      ).toBe('OPENAI');
    });
  });

  describe('2. Ausencia y valores invalidos', () => {
    it('2.1 deberia devolver null cuando el entorno calla', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const resolver = buildResolver();

      // 3. Assert 🎯: `null` es lo que hace caer al escalon siguiente, las
      //    constantes del DTO del nodo.
      expect(resolver.getTextDefaults()).toEqual({
        provider: null,
        model: null,
      });
      expect(resolver.getOcrDefaults()).toEqual({
        provider: null,
        model: null,
      });
    });

    it('2.2 deberia tratar la cadena vacia como ausencia', () => {
      // 1. Arrange 📐: una variable declarada sin valor es lo mismo que no
      //    declararla, y propagar `''` como modelo daria un 400 del proveedor.
      const resolver = buildResolver({
        [AI_DEFAULT_PROVIDER_VAR]: '   ',
        [AI_DEFAULT_MODEL_VAR]: '',
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(resolver.getTextDefaults()).toEqual({
        provider: null,
        model: null,
      });
    });

    it('2.3 deberia avisar e ignorar un proveedor desconocido, sin lanzar', () => {
      // 1. Arrange 📐: reventar el arranque por un default mal escrito seria
      //    desproporcionado. El sistema tiene un escalon mas abajo y sigue
      //    siendo capaz de ejecutar flujos; lo que no puede es decidirlo en
      //    silencio, de ahi el aviso.
      const resolver = buildResolver({
        [AI_DEFAULT_PROVIDER_VAR]: 'deepmind',
      });
      const warn = jest
        .spyOn(resolver['logger'], 'warn')
        .mockImplementation(() => undefined);

      // 2. Act ⚙️
      const defaults = resolver.getTextDefaults();

      // 3. Assert 🎯
      expect(defaults.provider).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(AI_DEFAULT_PROVIDER_VAR),
      );
    });
  });

  describe('3. Aislamiento entre los dos pares', () => {
    it('3.1 el par de OCR no deberia heredar del par de texto', () => {
      // 1. Arrange 📐: son dos decisiones distintas. El modelo bueno
      //    redactando no tiene por que ser el bueno —ni el barato— haciendo OCR.
      const resolver = buildResolver({
        [AI_DEFAULT_PROVIDER_VAR]: 'anthropic',
        [AI_DEFAULT_MODEL_VAR]: 'claude-3-5-sonnet-20241022',
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(resolver.getOcrDefaults()).toEqual({
        provider: null,
        model: null,
      });
    });
  });
  describe('4. Politica de red declarada en el entorno', () => {
    it('4.1 deberia leer los dos pares de espera y reintentos', () => {
      // 1. Arrange 📐: texto y OCR van en pares separados por el mismo motivo
      //    que el proveedor y el modelo — redactar una plantilla a partir de
      //    una tabla de trece comisiones tarda un orden de magnitud mas que
      //    transcribir un escaneado.
      const resolver = buildResolver({
        [LLM_HTTP_TIMEOUT_MS_VAR]: '60000',
        [LLM_HTTP_MAX_RETRIES_VAR]: '1',
        [OCR_HTTP_TIMEOUT_MS_VAR]: '30000',
        [OCR_HTTP_MAX_RETRIES_VAR]: '2',
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(resolver.getTextHttpDefaults()).toEqual({
        timeoutMs: 60_000,
        maxRetries: 1,
      });
      expect(resolver.getOcrHttpDefaults()).toEqual({
        timeoutMs: 30_000,
        maxRetries: 2,
      });
    });

    it('4.2 deberia devolver null cuando el entorno calla o va vacio', () => {
      // 1. Arrange 📐: `null` significa "no declarado", y es lo que hace que la
      //    estrategia caiga en las constantes del DTO.
      const mudo = buildResolver();
      const vacio = buildResolver({
        [LLM_HTTP_TIMEOUT_MS_VAR]: '   ',
        [LLM_HTTP_MAX_RETRIES_VAR]: '',
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(mudo.getTextHttpDefaults()).toEqual({
        timeoutMs: null,
        maxRetries: null,
      });
      expect(vacio.getTextHttpDefaults()).toEqual({
        timeoutMs: null,
        maxRetries: null,
      });
    });

    it('4.3 deberia aceptar CERO reintentos pero NO una espera de cero', () => {
      // 1. Arrange 📐: este es el caso que obliga a tener DOS lectores. En
      //    `maxRetries`, `0` es la peticion explicita de "no reintentes" y debe
      //    sobrevivir; en `timeoutMs`, `0` significa en Axios "sin limite", de
      //    modo que dejaria la peticion colgada para siempre y vale mas
      //    ignorarlo. Un solo lector con `> 0` haria imposible lo primero.
      const resolver = buildResolver({
        [LLM_HTTP_TIMEOUT_MS_VAR]: '0',
        [LLM_HTTP_MAX_RETRIES_VAR]: '0',
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(resolver.getTextHttpDefaults()).toEqual({
        timeoutMs: null,
        maxRetries: 0,
      });
    });

    it('4.4 deberia avisar e ignorar lo que no sea un entero valido', () => {
      // 1. Arrange 📐: un `.env` con una errata no debe tumbar el arranque, pero
      //    tampoco decidirlo en silencio. Se cubren las tres formas de errata:
      //    texto, decimal y negativo.
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      const resolver = buildResolver({
        [LLM_HTTP_TIMEOUT_MS_VAR]: 'sesenta mil',
        [LLM_HTTP_MAX_RETRIES_VAR]: '1.5',
        [OCR_HTTP_TIMEOUT_MS_VAR]: '-1',
      });

      // 2. Act ⚙️
      const texto = resolver.getTextHttpDefaults();
      const ocr = resolver.getOcrHttpDefaults();

      // 3. Assert 🎯
      expect(texto).toEqual({ timeoutMs: null, maxRetries: null });
      expect(ocr.timeoutMs).toBeNull();
      expect(warn).toHaveBeenCalledTimes(3);

      warn.mockRestore();
    });

    it('4.5 el par de OCR no deberia heredar del par de texto', () => {
      // 1. Arrange 📐: misma independencia que comprueba el bloque 3 para el
      //    proveedor y el modelo. Declarar solo la espera de texto no debe
      //    alargar la de la transcripcion.
      const resolver = buildResolver({
        [LLM_HTTP_TIMEOUT_MS_VAR]: '90000',
        [LLM_HTTP_MAX_RETRIES_VAR]: '0',
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(resolver.getOcrHttpDefaults()).toEqual({
        timeoutMs: null,
        maxRetries: null,
      });
    });
  });
});
