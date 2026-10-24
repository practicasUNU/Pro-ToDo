import { describe, expect, it } from 'vitest';

import { sortRows } from './table-sort';

interface Row extends Record<string, unknown> {
  name: string | null;
  cost: number;
  createdAt: string;
}

const rows: Row[] = [
  { name: 'Ñandú', cost: 3, createdAt: '2026-01-03T00:00:00.000Z' },
  { name: null, cost: 1, createdAt: '2026-01-01T00:00:00.000Z' },
  { name: 'ábaco', cost: 2, createdAt: '2026-01-02T00:00:00.000Z' },
];

const namesOf = (sorted: Row[]): (string | null)[] => sorted.map((row) => row.name);

describe('sortRows', () => {
  it('1.1 deberia devolver una COPIA y no tocar el array de origen', () => {
    // 1. Arrange 📐: ordenar en el sitio mutaria la coleccion del store y
    //    rompería la inmutabilidad del estado, ademas de disparar sus
    //    observadores (`frontend-architecture.md` §2.1).
    const original = [...rows];

    // 2. Act ⚙️
    const sorted = sortRows(rows, 'cost', false);

    // 3. Assert 🎯
    expect(sorted).not.toBe(rows);
    expect(rows).toEqual(original);
  });

  it('1.2 deberia conservar el orden del servidor sin criterio', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const sorted = sortRows(rows, null, false);

    // 3. Assert 🎯
    expect(namesOf(sorted)).toEqual(['Ñandú', null, 'ábaco']);
  });

  it('1.3 deberia ordenar numeros por valor y no como texto', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const sorted = sortRows([{ cost: 10 }, { cost: 9 }], 'cost', false);

    // 3. Assert 🎯: como texto, "10" iria antes que "9".
    expect(sorted.map((row) => row.cost)).toEqual([9, 10]);
  });

  it('1.4 deberia ordenar el texto con acentos y eñes en español', () => {
    // 1. Arrange 📐: comparando por punto de codigo, "Ñ" cae detras de "Z" y
    //    "á" detras de "z", que no es lo que espera quien lee.
    const sorted = sortRows(rows, 'name', false);

    // 3. Assert 🎯: el nulo va al final; "ábaco" antes que "Ñandú".
    expect(namesOf(sorted)).toEqual(['ábaco', 'Ñandú', null]);
  });

  it('1.5 deberia ordenar las fechas ISO cronologicamente', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const sorted = sortRows(rows, 'createdAt', true);

    // 3. Assert 🎯
    expect(sorted.map((row) => row.cost)).toEqual([3, 2, 1]);
  });

  it('1.6 deberia dejar los huecos al final en LAS DOS direcciones', () => {
    // 1. Arrange 📐: un hueco no es "menor que" nada, es la ausencia de dato.
    //    Verlo encabezando la tabla al ordenar por coste sugiere un cero que
    //    no existe.
    // 2. Act ⚙️
    const ascending = sortRows(rows, 'name', false);
    const descending = sortRows(rows, 'name', true);

    // 3. Assert 🎯
    expect(namesOf(ascending).at(-1)).toBeNull();
    expect(namesOf(descending).at(-1)).toBeNull();
  });

  it('1.7 deberia usar el resolutor de la columna cuando se le da uno', () => {
    // 1. Arrange 📐: las columnas cuyo `field` es una funcion no tienen una
    //    clave equivalente en la fila.
    const sorted = sortRows(rows, 'etiqueta', false, {
      etiqueta: (row) => row.cost * -1,
    });

    // 3. Assert 🎯
    expect(sorted.map((row) => row.cost)).toEqual([3, 2, 1]);
  });
});
