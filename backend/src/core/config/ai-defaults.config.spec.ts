import {
  AI_DEFAULT_MODEL_VAR,
  AI_DEFAULT_PROVIDER_VAR,
  AI_OCR_DEFAULT_MODEL_VAR,
  AI_OCR_DEFAULT_PROVIDER_VAR,
  AiDefaultsConfig,
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
});
