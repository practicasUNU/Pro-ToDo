import { describe, expect, it, jest } from '@jest/globals';

import { LlmProvider } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import { LlmProviderFactory } from '@modules/nodes/strategies/llm-provider.factory';
import { MockLlmProvider } from '@modules/nodes/strategies/providers/mock-llm.provider';

import type { AnthropicLlmProvider } from '@modules/nodes/strategies/providers/anthropic-llm.provider';
import type { GeminiLlmProvider } from '@modules/nodes/strategies/providers/gemini-llm.provider';

/**
 * Suite del INDICE de clientes.
 *
 * Lo que se fija aqui es que ningun proveedor con cliente acabe resolviendo al
 * simulador por accidente: ese es exactamente el fallo que vivio en el codigo
 * hasta PROT-21, cuando `OcrProcessorStrategy` no conocia `ANTHROPIC` y
 * degradaba en silencio, indistinguible de un proveedor inexistente.
 */

/** Dobles vacios: la factoria no los invoca, solo los indexa. */
const GEMINI = { provider: LlmProvider.GEMINI } as GeminiLlmProvider;
const ANTHROPIC = { provider: LlmProvider.ANTHROPIC } as AnthropicLlmProvider;

interface Harness {
  readonly factory: LlmProviderFactory;
  readonly mock: MockLlmProvider;
  readonly warn: jest.SpiedFunction<(message: string) => void>;
}

const buildHarness = (): Harness => {
  const mock = new MockLlmProvider();
  const factory = new LlmProviderFactory(mock, GEMINI, ANTHROPIC);
  const warn = jest
    .spyOn(factory['logger'], 'warn')
    .mockImplementation(() => undefined);

  return { factory, mock, warn };
};

describe('LlmProviderFactory · resolucion polimorfica de clientes LLM', () => {
  describe('1. Proveedores con cliente', () => {
    it('1.1 deberia devolver el cliente propio de cada proveedor registrado', () => {
      // 1. Arrange 📐
      const { factory, mock } = buildHarness();

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(factory.getClient(LlmProvider.MOCK)).toBe(mock);
      expect(factory.getClient(LlmProvider.GEMINI)).toBe(GEMINI);
      expect(factory.getClient(LlmProvider.ANTHROPIC)).toBe(ANTHROPIC);
    });

    it('1.2 deberia resolver ANTHROPIC sin degradar ni avisar', () => {
      // 1. Arrange 📐: este es el caso concreto que fallaba en la copia de OCR.
      //    Si vuelve a perderse, el sintoma seria una salida simulada sin que
      //    nadie lo note, asi que se fija aparte.
      const { factory, mock, warn } = buildHarness();

      // 2. Act ⚙️
      const client = factory.getClient(LlmProvider.ANTHROPIC);

      // 3. Assert 🎯
      expect(client).not.toBe(mock);
      expect(warn).not.toHaveBeenCalled();
    });

    it('1.3 hasClient deberia coincidir con lo que devuelve getClient', () => {
      // 1. Arrange 📐
      const { factory } = buildHarness();

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(factory.hasClient(LlmProvider.MOCK)).toBe(true);
      expect(factory.hasClient(LlmProvider.GEMINI)).toBe(true);
      expect(factory.hasClient(LlmProvider.ANTHROPIC)).toBe(true);
      expect(factory.getImplementedProviders()).toEqual(
        new Set([LlmProvider.MOCK, LlmProvider.GEMINI, LlmProvider.ANTHROPIC]),
      );
    });
  });

  describe('2. Proveedores sin cliente', () => {
    it('2.1 deberia degradar OPENAI al simulador con un aviso, sin lanzar', () => {
      // 1. Arrange 📐: criterio de PROT-16. `AI_DEFAULT_PROVIDER` puede nombrar
      //    un proveedor que aun no existe, y lanzar habria pausado de golpe
      //    todo flujo que no declarase el suyo.
      const { factory, mock, warn } = buildHarness();

      // 2. Act ⚙️
      const client = factory.getClient(LlmProvider.OPENAI);

      // 3. Assert 🎯
      expect(client).toBe(mock);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(LlmProvider.OPENAI),
      );
    });

    it('2.2 hasClient deberia decir que NO, y sin ensuciar el log', () => {
      // 1. Arrange 📐: lo consulta el catalogo en cada carga del asistente.
      //    Si avisara, el log se llenaria de advertencias cuando no ha pasado
      //    nada raro.
      const { factory, warn } = buildHarness();

      // 2. Act ⚙️
      const hasClient = factory.hasClient(LlmProvider.OPENAI);

      // 3. Assert 🎯
      expect(hasClient).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('3. Aislamiento del indice', () => {
    it('3.1 getImplementedProviders deberia devolver una copia, no el indice vivo', () => {
      // 1. Arrange 📐: mismo criterio que `NodeStrategyFactory`. Si devolviera
      //    la estructura interna, cualquier llamante podria darse de alta a si
      //    mismo sin pasar por el contenedor.
      const { factory } = buildHarness();

      // 2. Act ⚙️
      const providers = factory.getImplementedProviders() as Set<LlmProvider>;
      providers.delete(LlmProvider.GEMINI);

      // 3. Assert 🎯
      expect(factory.hasClient(LlmProvider.GEMINI)).toBe(true);
    });
  });
});
