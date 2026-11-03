import { MockLlmProvider } from '@modules/nodes/strategies/providers/mock-llm.provider';

import {
  RESPONSE_ITEMS_RULE,
  buildResponseContractInstruction,
  buildResponseJsonSchema,
  normalizeResponseItems,
} from './llm-provider.interface';

/**
 * Contrato de salida con cardinalidad 1 a N.
 *
 * El reparto es ASIMETRICO: la raiz describe el primer elemento e `items` los
 * restantes. Se fija aqui porque es el contrato COMPARTIDO por todos los
 * proveedores: si diverge en uno, un flujo funciona con Gemini y falla con
 * Anthropic sin que nada lo delate.
 */
describe('Contrato de salida del nodo de IA · cardinalidad 1 a N', () => {
  describe('1. Esquema JSON', () => {
    it('1.1 no deberia declarar "items" con cardinalidad simple', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const schema = buildResponseJsonSchema(true);

      // 3. Assert 🎯
      expect(Object.keys(schema.properties)).not.toContain('items');
      expect(schema.required).not.toContain('items');
    });

    it('1.2 deberia exigir "items" con el mismo contrato que la raiz cuando se pide un lote', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const schema = buildResponseJsonSchema(true, true);
      const items = (
        schema.properties as unknown as Record<
          string,
          {
            items: {
              required: string[];
              properties: Record<string, unknown>;
              additionalProperties: boolean;
            };
          }
        >
      ).items;

      // 3. Assert 🎯
      expect(schema.required).toContain('items');
      expect(items?.items.required).toEqual([
        'headline',
        'summary',
        'body_paragraphs',
        'filled_markup',
      ]);
      expect(Object.keys(items?.items.properties ?? {})).toContain(
        'source_url',
      );
      expect(items?.items.additionalProperties).toBe(false);
    });

    it('1.3 no deberia exigir filled_markup en los elementos sin plantilla', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const schema = buildResponseJsonSchema(false, true);
      const required = (
        schema.properties as unknown as Record<
          string,
          { items: { required: string[] } }
        >
      ).items?.items.required;

      // 3. Assert 🎯
      expect(required).toEqual(['headline', 'summary', 'body_paragraphs']);
    });
  });

  describe('2. Instruccion de contrato', () => {
    it('2.1 deberia anadir la regla del lote solo cuando se pide', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(buildResponseContractInstruction(true)).not.toContain(
        RESPONSE_ITEMS_RULE,
      );
      expect(buildResponseContractInstruction(true, true)).toContain(
        RESPONSE_ITEMS_RULE,
      );
      expect(RESPONSE_ITEMS_RULE).toContain('PRIMER elemento');
    });
  });

  describe('3. normalizeResponseItems', () => {
    it('3.1 deberia devolver undefined si el modelo no emitio un arreglo', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(normalizeResponseItems(undefined)).toBeUndefined();
      expect(normalizeResponseItems({ headline: 'x' })).toBeUndefined();
    });

    it('3.2 deberia descartar lo que no es un elemento y recortar los campos', () => {
      // 1. Arrange 📐
      const raw = [
        null,
        'texto suelto',
        [],
        {},
        {
          headline: '  Noticia 2 ',
          summary: 'Resumen',
          body_paragraphs: ['  uno ', 7, ''],
          filled_markup: '  <p>dos</p> ',
          source_url: '   ',
        },
      ];

      // 2. Act ⚙️
      const items = normalizeResponseItems(raw);

      // 3. Assert 🎯: el objeto vacio no describe nada y se descarta.
      expect(items).toEqual([
        {
          headline: 'Noticia 2',
          summary: 'Resumen',
          body_paragraphs: ['uno'],
          filled_markup: '<p>dos</p>',
        },
      ]);
    });
  });

  describe('4. Simulador', () => {
    it('4.1 deberia repartir el material en raiz + items con expectsItems', async () => {
      // 1. Arrange 📐
      const provider = new MockLlmProvider();

      // 2. Act ⚙️
      const payload = await provider.generateCompletion(
        'Primera noticia\n\nSegunda noticia\n\nTercera noticia',
        undefined,
        {
          model: 'mock-engine',
          timeoutMs: 1_000,
          maxRetries: 0,
          expectsItems: true,
          expectsFilledMarkup: true,
        },
      );

      // 3. Assert 🎯
      expect(payload.headline).toBe('Primera noticia');
      expect(payload.body_paragraphs).toEqual(['Primera noticia']);
      expect(payload.items?.map((item) => item.headline)).toEqual([
        'Segunda noticia',
        'Tercera noticia',
      ]);
      expect(payload.items?.[0]?.filled_markup).toContain('Segunda noticia');
    });

    it('4.2 no deberia emitir items sin expectsItems', async () => {
      // 1. Arrange 📐
      const provider = new MockLlmProvider();

      // 2. Act ⚙️
      const payload = await provider.generateCompletion('Uno\n\nDos');

      // 3. Assert 🎯
      expect(payload).not.toHaveProperty('items');
      expect(payload.body_paragraphs).toEqual(['Uno', 'Dos']);
    });
  });
});
