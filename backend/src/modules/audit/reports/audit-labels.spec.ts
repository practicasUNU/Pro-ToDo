import {
  changedAuditKeys,
  changedAuditPaths,
  flattenAuditSnapshot,
} from '@modules/audit/reports/audit-labels';

describe('audit-labels · diff anidado', () => {
  it('1.1 deberia aplanar objetos y arreglos anidados a rutas hoja', () => {
    // 1. Arrange 📐
    const snapshot = {
      name: 'Notiweb',
      pipelineSchema: {
        nodes: [{ nodeId: 'ocr', params: { customPrompt: 'A' } }],
      },
    };

    // 2. Act ⚙️
    const flat = flattenAuditSnapshot(snapshot);

    // 3. Assert 🎯
    expect(flat).toEqual({
      name: 'Notiweb',
      'pipelineSchema.nodes[0].nodeId': 'ocr',
      'pipelineSchema.nodes[0].params.customPrompt': 'A',
    });
  });

  it('1.2 deberia conservar como hoja los objetos y arreglos vacios', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const flat = flattenAuditSnapshot({ headers: {}, tags: [] });

    // 3. Assert 🎯: si no, pasar de `{ a: 1 }` a `{}` no dejaria rastro.
    expect(flat).toEqual({ headers: {}, tags: [] });
  });

  it('1.3 deberia senalar solo el campo anidado que cambio', () => {
    // 1. Arrange 📐: se edita el prompt de un nodo OCR del flujo.
    const previous = {
      pipelineSchema: {
        nodes: [{ nodeId: 'ocr', params: { customPrompt: 'Antes' } }],
      },
      updatedAt: '2026-10-01',
    };
    const next = {
      pipelineSchema: {
        nodes: [{ nodeId: 'ocr', params: { customPrompt: 'Despues' } }],
      },
      updatedAt: '2026-10-02',
    };

    // 2. Act ⚙️
    const paths = changedAuditPaths(previous, next);

    // 3. Assert 🎯: `updatedAt` es contabilidad y no cuenta.
    expect(paths).toEqual(['pipelineSchema.nodes[0].params.customPrompt']);
    expect(changedAuditKeys(previous, next)).toEqual(['pipelineSchema']);
  });

  it('1.4 deberia listar todas las rutas en un alta', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const paths = changedAuditPaths(null, { name: 'X', meta: { a: 1 } });

    // 3. Assert 🎯
    expect(paths).toEqual(['name', 'meta.a']);
  });
});
