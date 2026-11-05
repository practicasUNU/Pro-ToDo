import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@services/node-sandbox.service', () => ({
  runNodeSandbox: vi.fn(),
}));

import { runNodeSandbox } from '@services/node-sandbox.service';

import { canRunInSandbox, useNodeSandboxStore } from './node-sandbox.store';

import { NodeType } from '@/types/pipeline';
import { UserRole } from '@/types/user';

const PAYLOAD = {
  nodeType: NodeType.DESTINO_HTTP_GENERICO,
  params: { targetUrl: 'https://api.ejemplo.org' },
  upstreamContext: {},
};

describe('useNodeSandboxStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  describe('1. Permisos por tipo (replica del backend)', () => {
    it.each([
      [NodeType.PROCESADOR_IA, UserRole.ADMIN, true],
      [NodeType.PROCESADOR_IA, UserRole.EDITOR, false],
      [NodeType.PROCESADOR_OCR, UserRole.ADMIN, true],
      [NodeType.PROCESADOR_OCR, UserRole.EDITOR, false],
      [NodeType.DESTINO_HTTP_GENERICO, UserRole.EDITOR, true],
      [NodeType.DESTINO_HTTP_GENERICO, UserRole.ADMIN, true],
      [NodeType.TRIGGER_IMAP, UserRole.ADMIN, false],
    ])('1.1 %s con %s -> %s', (nodeType, role, expected) => {
      // 1. Arrange + 2. Act + 3. Assert
      expect(canRunInSandbox(nodeType, role)).toBe(expected);
    });

    it('1.2 NO deberia permitir nada sin sesion', () => {
      // 1. Arrange + 2. Act + 3. Assert
      expect(canRunInSandbox(NodeType.DESTINO_HTTP_GENERICO, null)).toBe(false);
    });
  });

  describe('2. Ejecucion', () => {
    it('2.1 deberia guardar el resultado y apagar isRunning', async () => {
      // 1. Arrange
      const store = useNodeSandboxStore();
      vi.mocked(runNodeSandbox).mockResolvedValue({ success: true, data: {}, durationMs: 5 });

      // 2. Act
      const outcome = await store.run(PAYLOAD);

      // 3. Assert
      expect(outcome.success).toBe(true);
      expect(store.lastResult).toEqual(outcome);
      expect(store.isRunning).toBe(false);
    });

    it('2.2 deberia propagar el error HTTP y apagar isRunning igualmente', async () => {
      // 1. Arrange: un 403 por rol.
      const store = useNodeSandboxStore();
      vi.mocked(runNodeSandbox).mockRejectedValue(new Error('403'));

      // 2. Act + 3. Assert
      await expect(store.run(PAYLOAD)).rejects.toThrow('403');
      expect(store.isRunning).toBe(false);
      expect(store.lastResult).toBeNull();
    });
  });
});
