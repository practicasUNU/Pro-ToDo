import { describe, expect, it } from 'vitest';

import { toSortKey, toSortQuery, toTableSort } from './table-sort';

const KEYS = ['createdAt', 'action'] as const;

describe('table-sort (orden en servidor)', () => {
  it('1.1 deberia aceptar una clave de la lista blanca', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const key = toSortKey(KEYS, 'action');

    // 3. Assert 🎯
    expect(key).toBe('action');
  });

  it.each([
    ['una columna no ordenable', 'details'],
    ['una inyeccion', 'createdAt;DROP TABLE usuarios'],
    ['una clave del prototipo', 'constructor'],
    ['un nulo', null],
    ['un indefinido', undefined],
  ])('1.2 deberia convertir %s en "sin criterio"', (_label, value) => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const key = toSortKey(KEYS, value);

    // 3. Assert 🎯
    expect(key).toBeNull();
  });

  it('1.3 deberia traducir el sentido de QTable a ASC/DESC', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const ascending = toSortQuery(toTableSort(KEYS, 'createdAt', false));
    const descending = toSortQuery(toTableSort(KEYS, 'createdAt', true));

    // 3. Assert 🎯
    expect(ascending).toEqual({ sortBy: 'createdAt', sortOrder: 'ASC' });
    expect(descending).toEqual({ sortBy: 'createdAt', sortOrder: 'DESC' });
  });

  it('1.4 NO deberia enviar parametros sin criterio, aunque QTable marque descendente', () => {
    // 1. Arrange 📐: el backend aplica entonces su orden por defecto.
    const sort = toTableSort(KEYS, null, true);

    // 2. Act ⚙️
    const query = toSortQuery(sort);

    // 3. Assert 🎯
    expect(sort).toEqual({ sortBy: null, descending: false });
    expect(query).toEqual({});
  });
});
