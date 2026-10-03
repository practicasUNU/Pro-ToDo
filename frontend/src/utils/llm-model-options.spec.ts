import { describe, expect, it } from 'vitest';

import { LlmProvider } from '@/types/nodes/llm-extractor.types';
import { UserRole } from '@/types/user';

import { buildModelOptions, isModelForbidden } from './llm-model-options';

import type { LlmModelDescriptor } from '@/types/nodes/llm-extractor.types';

/**
 * Suite del constructor de opciones del selector de modelo.
 *
 * Es pura y la comparten los dos nodos que consumen un LLM, asi que lo que se
 * fija aqui vale para los dos selectores a la vez: esa es justamente la razon
 * de que la logica no viva duplicada en cada store.
 */

const buildDescriptor = (overrides: Partial<LlmModelDescriptor> = {}): LlmModelDescriptor => ({
  provider: LlmProvider.GEMINI,
  model: 'gemini-1.5-flash',
  label: 'Gemini 1.5 Flash',
  isAvailable: true,
  isTestOnly: false,
  supportsVision: true,
  contextWindow: 1_000_000,
  ...overrides,
});

const PAID = buildDescriptor({
  provider: LlmProvider.ANTHROPIC,
  model: 'claude-haiku-4-5',
  label: 'Claude Haiku 4.5',
  contextWindow: 200_000,
  minRoleRequired: UserRole.ADMIN,
});

describe('buildModelOptions · opciones del selector de modelo', () => {
  describe('1. Restriccion por rol', () => {
    it('1.1 deberia deshabilitar un modelo de pago para un no ADMIN', () => {
      // 1. Arrange 📐 & 2. Act ⚙️
      const options = buildModelOptions([PAID], '', LlmProvider.GEMINI, false);

      // 3. Assert 🎯
      expect(options[0]?.disable).toBe(true);
    });

    it('1.2 deberia habilitarlo para un ADMIN', () => {
      // 1. Arrange 📐 & 2. Act ⚙️
      const options = buildModelOptions([PAID], '', LlmProvider.GEMINI, true);

      // 3. Assert 🎯
      expect(options[0]?.disable).toBe(false);
    });

    it('1.3 NO deberia tocar un modelo sin restriccion', () => {
      // 1. Arrange 📐: el free tier de Google es coste cero y lo puede usar
      //    cualquiera; es con lo que un EDITOR tiene que poder trabajar.
      const options = buildModelOptions([buildDescriptor()], '', LlmProvider.GEMINI, false);

      // 3. Assert 🎯
      expect(options[0]?.disable).toBe(false);
    });
  });

  describe('2. Modelo guardado fuera del catalogo', () => {
    it('2.1 deberia conservarlo como opcion marcada', () => {
      // 1. Arrange 📐: sin esto, un selector cerrado dejaria en blanco la
      //    configuracion de cualquier flujo que apunte a un modelo retirado de
      //    la tabla curada, y abrir el paso para mirarlo bastaria para
      //    romperlo al guardar.
      const options = buildModelOptions(
        [buildDescriptor()],
        'modelo-retirado',
        LlmProvider.GEMINI,
        false,
      );

      // 3. Assert 🎯
      const uncatalogued = options.find((option) => option.isUncatalogued);

      expect(uncatalogued?.value).toBe('modelo-retirado');
      expect(uncatalogued?.label).toContain('no catalogado');
    });

    it('2.2 NUNCA deberia deshabilitarlo, aunque el rol sea insuficiente', () => {
      // 1. Arrange 📐: es el valor que el flujo YA tiene guardado. Bloquearlo
      //    impediria abrir el paso para cambiarlo por otro, que es justo lo
      //    que hay que poder hacer.
      const options = buildModelOptions([], 'modelo-retirado', LlmProvider.GEMINI, false);

      // 3. Assert 🎯
      expect(options[0]?.disable).toBe(false);
    });

    it('2.3 NO deberia anadir nada si el modelo ya figura en el catalogo', () => {
      // 1. Arrange 📐 & 2. Act ⚙️
      const options = buildModelOptions(
        [buildDescriptor()],
        'gemini-1.5-flash',
        LlmProvider.GEMINI,
        false,
      );

      // 3. Assert 🎯
      expect(options).toHaveLength(1);
      expect(options[0]?.isUncatalogued).toBe(false);
    });
  });

  describe('3. Orden', () => {
    it('3.1 deberia poner los configurados por delante', () => {
      // 1. Arrange 📐: es como se lee un selector, y evita que el primero que
      //    se ve sea uno que no va a funcionar.
      const sinClave = buildDescriptor({
        model: 'sin-clave',
        isAvailable: false,
      });

      // 2. Act ⚙️
      const options = buildModelOptions(
        [sinClave, buildDescriptor()],
        '',
        LlmProvider.GEMINI,
        false,
      );

      // 3. Assert 🎯
      expect(options[0]?.value).toBe('gemini-1.5-flash');
    });
  });

  describe('4. isModelForbidden', () => {
    it('4.1 deberia detectar el modelo elegido vetado', () => {
      // 1. Arrange 📐
      const options = buildModelOptions([PAID], '', LlmProvider.GEMINI, false);

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(isModelForbidden(options, 'claude-haiku-4-5')).toBe(true);
      expect(isModelForbidden(options, 'gemini-1.5-flash')).toBe(false);
    });
  });
});
