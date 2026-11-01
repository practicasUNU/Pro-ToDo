import { describe, expect, it } from 'vitest';

import { parseSandboxNodeType } from './sandbox-node-type';

import { NodeType } from '@/types/pipeline';

const ALLOWED = [NodeType.DESTINO_DRUPAL, NodeType.PROCESADOR_IA];

describe('parseSandboxNodeType', () => {
  it('1.1 deberia aceptar un tipo registrado, sin distinguir mayusculas', () => {
    // 2. Act + 3. Assert 🎯
    expect(parseSandboxNodeType('destino_drupal', ALLOWED)).toBe(NodeType.DESTINO_DRUPAL);
    expect(parseSandboxNodeType([' PROCESADOR_IA '], ALLOWED)).toBe(NodeType.PROCESADOR_IA);
  });

  it('1.2 deberia devolver null ante un tipo sin configurador o un valor no textual', () => {
    // 2. Act + 3. Assert 🎯
    expect(parseSandboxNodeType(NodeType.MAPEADOR_PLANTILLA, ALLOWED)).toBeNull();
    expect(parseSandboxNodeType('NO_EXISTE', ALLOWED)).toBeNull();
    expect(parseSandboxNodeType(undefined, ALLOWED)).toBeNull();
    expect(parseSandboxNodeType([], ALLOWED)).toBeNull();
  });
});
