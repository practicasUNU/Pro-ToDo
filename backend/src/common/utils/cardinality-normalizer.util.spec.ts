import {
  expandRootAndItems,
  normalizeCardinality,
  normalizeItems,
  resolveCardinality,
} from '@common/utils/cardinality-normalizer.util';

import type { OutputCardinalityMode } from '@common/utils/cardinality-normalizer.util';

describe('cardinality-normalizer.util', () => {
  describe('normalizeItems', () => {
    it('deberia envolver un objeto suelto en un arreglo unitario (1 a 1)', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(normalizeItems({ id: 1 })).toEqual([{ id: 1 }]);
    });

    it('deberia devolver un arreglo tal cual, sin huecos', () => {
      // 1. Arrange 📐
      const payload = [{ id: 1 }, null, { id: 2 }, undefined];

      // 2. Act ⚙️
      const items = normalizeItems(payload);

      // 3. Assert 🎯
      expect(items).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it('deberia extraer el contenedor "items" por defecto', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(normalizeItems({ items: [{ id: 1 }, { id: 2 }] })).toEqual([
        { id: 1 },
        { id: 2 },
      ]);
    });

    it('deberia extraer un contenedor declarado como "panels"', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(
        normalizeItems(
          { panels: [{ code: 'UPM' }, { code: 'UAM' }] },
          'panels',
        ),
      ).toEqual([{ code: 'UPM' }, { code: 'UAM' }]);
    });

    it('deberia tratar un contenedor con un objeto suelto como un unico elemento', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(normalizeItems({ items: { id: 1 } })).toEqual([{ id: 1 }]);
    });

    it.each([null, undefined, 42, 'texto', true])(
      'deberia devolver [] ante %p',
      (payload) => {
        // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
        expect(normalizeItems(payload)).toEqual([]);
      },
    );
  });

  describe('expandRootAndItems', () => {
    it('deberia unir la raiz y los restantes en orden, sin el contenedor', () => {
      // 1. Arrange 📐
      const root = { id: 1, items: [{ id: 2 }, { id: 3 }] };

      // 2. Act ⚙️
      const expanded = expandRootAndItems(root);

      // 3. Assert 🎯
      expect(expanded).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    });

    it('deberia devolver solo la raiz cuando no hay lote', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(expandRootAndItems({ id: 1 })).toEqual([{ id: 1 }]);
      expect(expandRootAndItems({ id: 1, items: [] })).toEqual([{ id: 1 }]);
    });

    it('deberia admitir otra clave de contenedor sin modificar la entrada', () => {
      // 1. Arrange 📐
      const root = {
        validated_markup: '<p>1</p>',
        validated_items: [{ validated_markup: '<p>2</p>' }],
      };

      // 2. Act ⚙️
      const expanded = expandRootAndItems(root, 'validated_items');

      // 3. Assert 🎯
      expect(expanded).toEqual([
        { validated_markup: '<p>1</p>' },
        { validated_markup: '<p>2</p>' },
      ]);
      expect(root.validated_items).toHaveLength(1);
    });
  });

  describe('resolveCardinality', () => {
    it.each<[OutputCardinalityMode, number, 'SINGLE' | 'MULTIPLE']>([
      ['SINGLE', 1, 'SINGLE'],
      ['SINGLE', 3, 'SINGLE'],
      ['MULTIPLE', 1, 'MULTIPLE'],
      ['MULTIPLE', 3, 'MULTIPLE'],
      ['AUTO', 1, 'SINGLE'],
      ['AUTO', 3, 'MULTIPLE'],
    ])(
      'deberia resolver %s con %i elemento(s) como %s',
      (mode, count, expected) => {
        // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
        expect(resolveCardinality(mode, count)).toBe(expected);
      },
    );
  });

  describe('normalizeCardinality (tri-estado)', () => {
    it.each<OutputCardinalityMode>(['MULTIPLE', 'AUTO'])(
      'deberia entregar la raiz limpia e items: [root] con N=1 en %s',
      (mode) => {
        // 1. Arrange 📐: contrato asimetrico con un solo elemento.
        const payload = { headline: 'Unica', items: [] };

        // 2. Act ⚙️
        const normalized = normalizeCardinality(payload, mode);

        // 3. Assert 🎯
        expect(normalized.root).toEqual({ headline: 'Unica' });
        expect(normalized.items).toEqual([normalized.root]);
        expect(normalized.items[0]).toBe(normalized.root);
      },
    );

    it('deberia resolver N=1 como SINGLE en AUTO y como MULTIPLE en MULTIPLE', () => {
      // 1. Arrange 📐
      const payload = { headline: 'Unica', items: [] };

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(normalizeCardinality(payload, 'AUTO').cardinality).toBe('SINGLE');
      expect(normalizeCardinality(payload, 'MULTIPLE').cardinality).toBe(
        'MULTIPLE',
      );
    });

    it.each<OutputCardinalityMode>(['MULTIPLE', 'AUTO'])(
      'deberia entregar la lista completa en orden con N=3 en %s sin mutar la entrada',
      (mode) => {
        // 1. Arrange 📐
        const payload = {
          headline: 'Uno',
          items: [{ headline: 'Dos' }, { headline: 'Tres' }],
        };

        // 2. Act ⚙️
        const normalized = normalizeCardinality(payload, mode);

        // 3. Assert 🎯
        expect(normalized.cardinality).toBe('MULTIPLE');
        expect(normalized.root).toEqual({ headline: 'Uno' });
        expect(normalized.items.map((item) => item.headline)).toEqual([
          'Uno',
          'Dos',
          'Tres',
        ]);
        expect(payload.items).toHaveLength(2);
      },
    );

    it('deberia ignorar el lote en SINGLE y quedarse con la raiz', () => {
      // 1. Arrange 📐
      const payload = { headline: 'Uno', items: [{ headline: 'Dos' }] };

      // 2. Act ⚙️
      const normalized = normalizeCardinality(payload, 'SINGLE');

      // 3. Assert 🎯
      expect(normalized.cardinality).toBe('SINGLE');
      expect(normalized.items).toEqual([{ headline: 'Uno' }]);
    });

    it('deberia admitir otra clave de contenedor (validated_items)', () => {
      // 1. Arrange 📐
      const payload = {
        validated_markup: '<p>1</p>',
        validated_items: [{ validated_markup: '<p>2</p>' }],
      };

      // 2. Act ⚙️
      const normalized = normalizeCardinality(
        payload,
        'MULTIPLE',
        'validated_items',
      );

      // 3. Assert 🎯
      expect(normalized.items).toEqual([
        { validated_markup: '<p>1</p>' },
        { validated_markup: '<p>2</p>' },
      ]);
    });
  });
});
