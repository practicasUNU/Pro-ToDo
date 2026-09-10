import { describe, expect, it } from 'vitest';

import {
  assemblePipelineSchema,
  disassemblePipelineSchema,
  INITIAL_SCHEMA_VERSION,
} from '@/utils/pipeline-assembler';

import { NodeType } from '@/types/pipeline';

import type { AssemblerStep } from '@/utils/pipeline-assembler';

const step = (
  nodeId: string,
  nodeType: NodeType,
  params: Record<string, unknown> = {},
): AssemblerStep => ({
  nodeId,
  nodeType,
  outputNamespace: nodeId,
  params,
});

const TRIGGER = step('trigger_imap', NodeType.TRIGGER_IMAP, { mailbox: 'INBOX' });
const PARSER = step('parser_pre_ia', NodeType.PARSER_PRE_IA);
const MAPPER = step('mapeador_plantilla', NodeType.MAPEADOR_PLANTILLA, {
  templateId: 'tpl-1',
});

const META = { flowId: 'flujo-1', name: 'Notiweb' };

describe('assemblePipelineSchema · encadenado de una secuencia ordenada', () => {
  describe('1. Punteros del grafo', () => {
    it('1.1 deberia tomar el primer paso como entrypoint', () => {
      // 1. Arrange & 2. Act
      const schema = assemblePipelineSchema([TRIGGER, PARSER, MAPPER], META);

      // 3. Assert
      expect(schema.entrypoint).toBe('trigger_imap');
    });

    it('1.2 deberia encadenar nextStep con el nodo siguiente del arreglo', () => {
      // 1. Arrange & 2. Act
      const schema = assemblePipelineSchema([TRIGGER, PARSER, MAPPER], META);

      // 3. Assert
      expect(schema.nodes.trigger_imap?.nextStep).toBe('parser_pre_ia');
      expect(schema.nodes.parser_pre_ia?.nextStep).toBe('mapeador_plantilla');
    });

    it('1.3 deberia dejar nextStep en null en el nodo terminal', () => {
      // 1. Arrange & 2. Act
      const schema = assemblePipelineSchema([TRIGGER, MAPPER], META);

      // 3. Assert
      expect(schema.nodes.mapeador_plantilla?.nextStep).toBeNull();
    });

    // Ninguna vista ofrece todavia configurar caminos de recuperacion, y un
    // puntero inventado seria peor que su ausencia: con `null` el motor detiene
    // la ejecucion en el nodo que falla.
    it('1.4 deberia dejar onErrorStep en null en TODOS los nodos', () => {
      // 1. Arrange & 2. Act
      const schema = assemblePipelineSchema([TRIGGER, PARSER, MAPPER], META);

      // 3. Assert
      expect(Object.values(schema.nodes).every((node) => node.onErrorStep === null)).toBe(true);
    });

    it('1.5 deberia reflejar el reordenado en los punteros, no solo en el orden', () => {
      // 1. Arrange: la misma terna, invertida
      const schema = assemblePipelineSchema([MAPPER, PARSER, TRIGGER], META);

      // 2. Act & 3. Assert
      expect(schema.entrypoint).toBe('mapeador_plantilla');
      expect(schema.nodes.mapeador_plantilla?.nextStep).toBe('parser_pre_ia');
      expect(schema.nodes.trigger_imap?.nextStep).toBeNull();
    });
  });

  describe('2. Metadatos y params', () => {
    it('2.1 deberia propagar flowId y name, y aplicar la version por defecto', () => {
      // 1. Arrange & 2. Act
      const schema = assemblePipelineSchema([TRIGGER], META);

      // 3. Assert
      expect(schema.flowId).toBe('flujo-1');
      expect(schema.name).toBe('Notiweb');
      expect(schema.version).toBe(INITIAL_SCHEMA_VERSION);
    });

    it('2.2 deberia respetar una version explicita', () => {
      // 1. Arrange & 2. Act
      const schema = assemblePipelineSchema([TRIGGER], { ...META, version: '2.1.0' });

      // 3. Assert
      expect(schema.version).toBe('2.1.0');
    });

    it('2.3 deberia conservar los params que aporta cada paso', () => {
      // 1. Arrange & 2. Act
      const schema = assemblePipelineSchema([TRIGGER, MAPPER], META);

      // 3. Assert
      expect(schema.nodes.trigger_imap?.params).toEqual({ mailbox: 'INBOX' });
      expect(schema.nodes.mapeador_plantilla?.params).toEqual({ templateId: 'tpl-1' });
    });
  });

  describe('3. Secuencia vacia', () => {
    // Es el estado legitimo de un borrador recien abierto; quien decide si eso
    // se puede guardar es el backend, no este helper.
    it('3.1 deberia devolver un esquema vacio sin lanzar', () => {
      // 1. Arrange & 2. Act
      const schema = assemblePipelineSchema([], META);

      // 3. Assert
      expect(schema.entrypoint).toBe('');
      expect(schema.nodes).toEqual({});
    });
  });
});

describe('disassemblePipelineSchema · recorrido inverso', () => {
  describe('4. Ida y vuelta', () => {
    it('4.1 deberia recuperar la secuencia original', () => {
      // 1. Arrange
      const schema = assemblePipelineSchema([TRIGGER, PARSER, MAPPER], META);

      // 2. Act
      const steps = disassemblePipelineSchema(schema);

      // 3. Assert
      expect(steps).toEqual([TRIGGER, PARSER, MAPPER]);
    });

    it('4.2 deberia recorrer el grafo y NO el orden de las claves del objeto', () => {
      // 1. Arrange: las claves se insertan al reves del encadenado
      const schema = {
        ...assemblePipelineSchema([TRIGGER, PARSER], META),
        nodes: {
          parser_pre_ia: {
            nodeId: 'parser_pre_ia',
            nodeType: NodeType.PARSER_PRE_IA,
            outputNamespace: 'parser_pre_ia',
            nextStep: null,
            onErrorStep: null,
            params: {},
          },
          trigger_imap: {
            nodeId: 'trigger_imap',
            nodeType: NodeType.TRIGGER_IMAP,
            outputNamespace: 'trigger_imap',
            nextStep: 'parser_pre_ia',
            onErrorStep: null,
            params: { mailbox: 'INBOX' },
          },
        },
      };

      // 2. Act
      const steps = disassemblePipelineSchema(schema);

      // 3. Assert
      expect(steps.map((current) => current.nodeId)).toEqual(['trigger_imap', 'parser_pre_ia']);
    });
  });

  describe('5. Grafos hostiles', () => {
    // El JSON es editable a mano, asi que puede llegar con un nextStep que
    // apunte hacia atras. Sin el conjunto de visitados esto colgaria la pestana.
    it('5.1 deberia cortar ante un ciclo en vez de colgarse', () => {
      // 1. Arrange
      const schema = {
        flowId: 'f',
        name: 'ciclico',
        version: '1.0.0',
        entrypoint: 'a',
        nodes: {
          a: {
            nodeId: 'a',
            nodeType: NodeType.TRIGGER_IMAP,
            outputNamespace: 'a',
            nextStep: 'b',
            onErrorStep: null,
            params: {},
          },
          b: {
            nodeId: 'b',
            nodeType: NodeType.PARSER_PRE_IA,
            outputNamespace: 'b',
            nextStep: 'a',
            onErrorStep: null,
            params: {},
          },
        },
      };

      // 2. Act
      const steps = disassemblePipelineSchema(schema);

      // 3. Assert
      expect(steps.map((current) => current.nodeId)).toEqual(['a', 'b']);
    });

    it('5.2 deberia truncar el recorrido ante un puntero huerfano', () => {
      // 1. Arrange
      const schema = {
        flowId: 'f',
        name: 'huerfano',
        version: '1.0.0',
        entrypoint: 'a',
        nodes: {
          a: {
            nodeId: 'a',
            nodeType: NodeType.TRIGGER_IMAP,
            outputNamespace: 'a',
            nextStep: 'no_existe',
            onErrorStep: null,
            params: {},
          },
        },
      };

      // 2. Act
      const steps = disassemblePipelineSchema(schema);

      // 3. Assert
      expect(steps.map((current) => current.nodeId)).toEqual(['a']);
    });

    it('5.3 deberia devolver [] si el entrypoint esta vacio', () => {
      // 1. Arrange & 2. Act & 3. Assert
      expect(disassemblePipelineSchema(assemblePipelineSchema([], META))).toEqual([]);
    });
  });
});
