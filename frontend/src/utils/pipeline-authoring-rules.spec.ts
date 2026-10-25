import { describe, expect, it } from 'vitest';

import {
  describeAuthoringIssue,
  findDestinationBeforeProcessing,
  findDuplicateAddition,
  findDuplicateNodeType,
} from './pipeline-authoring-rules';

import { NodeType } from '@/types/pipeline';

const DUPLICATE_HTTP =
  "El tipo de nodo 'Destino HTTP genérico' ya está presente en este flujo y no se puede duplicar.";

describe('pipeline-authoring-rules', () => {
  describe('1. Duplicados por tipo', () => {
    it('1.1 deberia bloquear un segundo destino del MISMO tipo con el mensaje exacto', () => {
      // 1. Arrange
      const steps = [{ nodeType: NodeType.DESTINO_HTTP_GENERICO }];

      // 2. Act
      const message = findDuplicateAddition(steps, NodeType.DESTINO_HTTP_GENERICO);

      // 3. Assert
      expect(message).toBe(DUPLICATE_HTTP);
    });

    it('1.2 deberia admitir destinos de tipos distintos', () => {
      // 1. Arrange
      const steps = [{ nodeType: NodeType.DESTINO_DRUPAL }];

      // 2. Act
      const message = findDuplicateAddition(steps, NodeType.DESTINO_HTTP_GENERICO);

      // 3. Assert
      expect(message).toBeNull();
    });

    it('1.3 deberia admitir disparadores de tipos distintos', () => {
      // 1. Arrange
      const steps = [{ nodeType: NodeType.TRIGGER_IMAP }];

      // 2. Act
      const message = findDuplicateAddition(steps, NodeType.TRIGGER_CRON);

      // 3. Assert
      expect(message).toBeNull();
    });

    it('1.4 NO deberia restringir los nodos de procesamiento repetidos', () => {
      // 1. Arrange: dos OCR o dos IA son un patron legitimo.
      const steps = [{ nodeType: NodeType.PROCESADOR_IA }];

      // 2. Act
      const message = findDuplicateAddition(steps, NodeType.PROCESADOR_IA);

      // 3. Assert
      expect(message).toBeNull();
    });

    it('1.5 deberia encontrar el primer duplicado en un conjunto ya armado', () => {
      // 1. Arrange
      const steps = [{ nodeType: NodeType.TRIGGER_CRON }, { nodeType: NodeType.TRIGGER_CRON }];

      // 2. Act
      const message = findDuplicateNodeType(steps);

      // 3. Assert
      expect(message).toContain("'Disparador Cron'");
    });
  });

  describe('2. Destino despues del procesamiento', () => {
    it('2.1 deberia rechazar un destino que sigue directamente al disparador', () => {
      // 1. Arrange
      const path = [{ nodeType: NodeType.TRIGGER_IMAP }, { nodeType: NodeType.DESTINO_DRUPAL }];

      // 2. Act
      const message = findDestinationBeforeProcessing(path);

      // 3. Assert
      expect(message).toContain("El destino 'Destino Drupal'");
    });

    it('2.2 NO deberia contar una pausa como procesamiento', () => {
      // 1. Arrange
      const path = [
        { nodeType: NodeType.TRIGGER_IMAP },
        { nodeType: NodeType.PAUSA_FLOW },
        { nodeType: NodeType.DESTINO_SMTP },
      ];

      // 2. Act
      const message = findDestinationBeforeProcessing(path);

      // 3. Assert
      expect(message).not.toBeNull();
    });

    it('2.3 deberia aceptar un destino tras el procesamiento', () => {
      // 1. Arrange
      const path = [
        { nodeType: NodeType.TRIGGER_IMAP },
        { nodeType: NodeType.PARSER_PRE_IA },
        { nodeType: NodeType.DESTINO_HTTP_GENERICO },
      ];

      // 2. Act
      const message = findDestinationBeforeProcessing(path);

      // 3. Assert
      expect(message).toBeNull();
    });
  });

  describe('3. Veredicto sobre un pipeline_schema sin tipar', () => {
    const node = (nodeType: string, nextStep: string | null = null) => ({ nodeType, nextStep });

    it('3.1 NO deberia juzgar un satelite de alerta colgado del disparador', () => {
      // 1. Arrange: el satelite SMTP no esta en el camino de `nextStep`.
      const schema = {
        entrypoint: 'trigger',
        nodes: {
          trigger: node(NodeType.TRIGGER_IMAP, 'parser'),
          parser: node(NodeType.PARSER_PRE_IA, 'destino'),
          destino: node(NodeType.DESTINO_DRUPAL),
          alerta: node(NodeType.DESTINO_SMTP),
        },
      };

      // 2. Act
      const issue = describeAuthoringIssue(schema);

      // 3. Assert
      expect(issue).toBeNull();
    });

    it('3.2 deberia detectar un duplicado aunque este fuera del camino activo', () => {
      // 1. Arrange
      const schema = {
        entrypoint: 'trigger',
        nodes: {
          trigger: node(NodeType.TRIGGER_IMAP, 'parser'),
          parser: node(NodeType.PARSER_PRE_IA, 'destino'),
          destino: node(NodeType.DESTINO_HTTP_GENERICO),
          otro: node(NodeType.DESTINO_HTTP_GENERICO),
        },
      };

      // 2. Act
      const issue = describeAuthoringIssue(schema);

      // 3. Assert
      expect(issue).toBe(DUPLICATE_HTTP);
    });

    it('3.3 deberia dejar pasar un documento ilegible y no colgarse con un ciclo', () => {
      // 1. Arrange
      const cyclic = {
        entrypoint: 'a',
        nodes: { a: node(NodeType.TRIGGER_IMAP, 'b'), b: node(NodeType.PARSER_PRE_IA, 'a') },
      };

      // 2. Act + 3. Assert
      expect(describeAuthoringIssue(null)).toBeNull();
      expect(describeAuthoringIssue({ nodes: [] })).toBeNull();
      expect(describeAuthoringIssue(cyclic)).toBeNull();
    });
  });
});
