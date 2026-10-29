import { describe, expect, it } from 'vitest';

import { changedPaths, computeAuditDiff, flattenSnapshot, formatLeaf } from '@/utils/audit-diff';

describe('audit-diff (diferencia anidada de auditoria)', () => {
  it('1.1 flattenSnapshot deberia aplanar objetos y arreglos a rutas hoja', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const flat = flattenSnapshot({ a: { b: [1, { c: 'x' }] }, empty: {} });

    // 3. Assert 🎯
    expect(flat).toEqual({ 'a.b[0]': 1, 'a.b[1].c': 'x', empty: {} });
  });

  it('1.2 computeAuditDiff deberia bajar hasta el campo anidado que cambio', () => {
    // 1. Arrange 📐: editar el prompt de un nodo OCR del flujo.
    const previous = {
      pipelineSchema: { nodes: [{ nodeId: 'ocr', params: { customPrompt: 'Antes' } }] },
      updatedAt: '2026-10-01',
    };
    const next = {
      pipelineSchema: { nodes: [{ nodeId: 'ocr', params: { customPrompt: 'Despues' } }] },
      updatedAt: '2026-10-02',
    };

    // 2. Act ⚙️
    const diff = computeAuditDiff(previous, next);

    // 3. Assert 🎯: la contabilidad (`updatedAt`) no cuenta como cambio.
    expect(diff).toEqual([
      {
        path: 'pipelineSchema.nodes[0].params.customPrompt',
        kind: 'changed',
        before: 'Antes',
        after: 'Despues',
      },
    ]);
  });

  it('1.3 deberia clasificar altas y bajas de rutas', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const diff = computeAuditDiff({ old: true }, { added: 3 });

    // 3. Assert 🎯
    expect(diff).toEqual([
      { path: 'old', kind: 'removed', before: 'true', after: '—' },
      { path: 'added', kind: 'added', before: '—', after: '3' },
    ]);
  });

  it('1.4 changedPaths deberia devolver solo las rutas', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(changedPaths(null, { name: 'Alta', meta: { a: 1 } })).toEqual(['name', 'meta.a']);
    expect(changedPaths({ s: { a: 1 } }, { s: { a: 1 } })).toEqual([]);
  });

  it('1.5 formatLeaf no deberia producir nunca "[object Object]"', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(formatLeaf({})).toBe('{}');
    expect(formatLeaf(null)).toBe('null');
    expect(formatLeaf('texto')).toBe('texto');
    expect(formatLeaf(undefined)).toBe('—');
  });
});
