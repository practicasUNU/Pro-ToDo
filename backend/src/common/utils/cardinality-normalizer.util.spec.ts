import {
  expandRootAndItems,
  normalizeItems,
} from '@common/utils/cardinality-normalizer.util';

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
});
