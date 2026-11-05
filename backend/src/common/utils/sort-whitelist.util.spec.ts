import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import {
  resolveSort,
  SortByField,
  SortOrderField,
} from '@common/utils/sort-whitelist.util';

import type { SortOrder } from '@common/utils/sort-whitelist.util';

const WHITELIST = {
  createdAt: 'e.createdAt',
  action: 'e.action',
} as const;

const FALLBACK = { key: 'createdAt', order: 'DESC' } as const;

class SortQuery {
  @SortByField(Object.keys(WHITELIST))
  readonly sortBy?: string;

  @SortOrderField()
  readonly sortOrder?: SortOrder;
}

const validate = (raw: Record<string, unknown>): string[] =>
  validateSync(plainToInstance(SortQuery, raw)).map((error) => error.property);

describe('resolveSort', () => {
  it('1.1 deberia traducir una clave admitida a su columna fija', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const sort = resolveSort(WHITELIST, 'action', 'ASC', FALLBACK);

    // 3. Assert 🎯
    expect(sort).toEqual({ column: 'e.action', order: 'ASC' });
  });

  it('1.2 deberia caer al orden por defecto sin criterio', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const sort = resolveSort(WHITELIST, undefined, undefined, FALLBACK);

    // 3. Assert 🎯
    expect(sort).toEqual({ column: 'e.createdAt', order: 'DESC' });
  });

  it.each([
    ['una inyeccion con punto y coma', 'createdAt; DROP TABLE usuarios --'],
    ['una subconsulta', '(SELECT 1)'],
    ['un indice posicional', '1'],
    ['una clave del prototipo', 'constructor'],
    ['__proto__', '__proto__'],
    ['la columna SQL real', 'e.creado_en'],
  ])(
    '1.3 NUNCA deberia devolver el texto del cliente: %s',
    (_label, sortBy) => {
      // 1. Arrange 📐: segunda linea de defensa, por si el DTO no corrio.
      // 2. Act ⚙️
      const sort = resolveSort(WHITELIST, sortBy, 'ASC', FALLBACK);

      // 3. Assert 🎯: solo literales del codigo fuente llegan al SQL.
      expect(sort).toEqual({ column: 'e.createdAt', order: 'DESC' });
      expect(Object.values(WHITELIST)).toContain(sort.column);
    },
  );

  it('1.4 deberia ignorar una direccion ajena aunque la clave sea valida', () => {
    // 1. Arrange 📐
    const hostile = 'ASC, (SELECT pg_sleep(5))' as SortOrder;

    // 2. Act ⚙️
    const sort = resolveSort(WHITELIST, 'action', hostile, FALLBACK);

    // 3. Assert 🎯
    expect(sort).toEqual({ column: 'e.action', order: 'DESC' });
  });
});

describe('SortByField / SortOrderField', () => {
  it('2.1 deberia aceptar una clave admitida y normalizar `asc`', () => {
    // 1. Arrange 📐
    const dto = plainToInstance(SortQuery, {
      sortBy: 'action',
      sortOrder: 'asc',
    });

    // 2. Act ⚙️
    const errors = validateSync(dto);

    // 3. Assert 🎯
    expect(errors).toHaveLength(0);
    expect(dto.sortOrder).toBe('ASC');
  });

  it.each([
    ['inyeccion', { sortBy: 'createdAt;DROP TABLE usuarios' }, 'sortBy'],
    ['array', { sortBy: ['createdAt'] }, 'sortBy'],
    ['objeto', { sortBy: { $ne: 1 } }, 'sortBy'],
    ['mayusculas distintas', { sortBy: 'CREATEDAT' }, 'sortBy'],
    ['espacios', { sortBy: ' createdAt ' }, 'sortBy'],
    ['direccion compuesta', { sortOrder: 'asc,id' }, 'sortOrder'],
    ['direccion numerica', { sortOrder: 1 }, 'sortOrder'],
  ])('2.2 deberia rechazar %s', (_label, raw, property) => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const failing = validate(raw);

    // 3. Assert 🎯
    expect(failing).toEqual([property]);
  });
});
