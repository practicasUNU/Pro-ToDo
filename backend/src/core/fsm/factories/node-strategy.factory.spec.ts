import { StrategyNotFoundException } from '@core/fsm/exceptions/strategy-not-found.exception';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';

import { NodeStrategyFactory } from './node-strategy.factory';

import type {
  INodeStrategy,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';

/**
 * Estrategia doble: la factoria solo indexa por `nodeType`, asi que `execute`
 * nunca llega a invocarse en estas pruebas.
 */
const buildStrategy = (nodeType: NodeType): INodeStrategy => ({
  nodeType,
  execute: (): Promise<NodeResult> => Promise.resolve({ success: true }),
});

/** Factoria con el logger silenciado, para no ensuciar la salida de Jest. */
const buildFactory = (): NodeStrategyFactory => {
  const factory = new NodeStrategyFactory();

  jest.spyOn(factory['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(factory['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(factory['logger'], 'error').mockImplementation(() => undefined);

  return factory;
};

describe('NodeStrategyFactory', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('1. Registro y resolucion', () => {
    it('1.1 deberia devolver la estrategia registrada para su tipo', () => {
      // 1. Arrange
      const factory = buildFactory();
      const strategy = buildStrategy(NodeType.TRIGGER_CRON);

      // 2. Act
      factory.registerStrategy(strategy);

      // 3. Assert
      expect(factory.getStrategy(NodeType.TRIGGER_CRON)).toBe(strategy);
    });

    it('1.2 deberia lanzar si el tipo no tiene estrategia', () => {
      // 1. Arrange
      const factory = buildFactory();

      // 2. Act & 3. Assert
      expect(() => factory.getStrategy(NodeType.PROCESADOR_IA)).toThrow(
        StrategyNotFoundException,
      );
    });

    it('1.3 deberia sustituir la estrategia al registrar dos veces el mismo tipo', () => {
      // 1. Arrange
      const factory = buildFactory();
      const first = buildStrategy(NodeType.TRIGGER_IMAP);
      const second = buildStrategy(NodeType.TRIGGER_IMAP);

      // 2. Act
      factory.registerStrategy(first);
      factory.registerStrategy(second);

      // 3. Assert
      expect(factory.getStrategy(NodeType.TRIGGER_IMAP)).toBe(second);
    });
  });

  describe('2. Listado de tipos registrados', () => {
    it('2.1 deberia empezar vacio', () => {
      // 1. Arrange & 2. Act
      const factory = buildFactory();

      // 3. Assert: es el motivo por el que el catalogo no puede cachear este
      //    conjunto en su constructor, que corre antes de los `onModuleInit`.
      expect(factory.getRegisteredNodeTypes().size).toBe(0);
    });

    it('2.2 deberia contener exactamente los tipos registrados', () => {
      // 1. Arrange
      const factory = buildFactory();

      // 2. Act
      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP));
      factory.registerStrategy(buildStrategy(NodeType.MAPEADOR_PLANTILLA));

      // 3. Assert
      const registered = factory.getRegisteredNodeTypes();
      expect([...registered].sort()).toEqual(
        [NodeType.MAPEADOR_PLANTILLA, NodeType.TRIGGER_IMAP].sort(),
      );
      expect(registered.has(NodeType.PROCESADOR_IA)).toBe(false);
    });

    it('2.3 no deberia duplicar un tipo registrado dos veces', () => {
      // 1. Arrange
      const factory = buildFactory();

      // 2. Act
      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_CRON));
      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_CRON));

      // 3. Assert
      expect(factory.getRegisteredNodeTypes().size).toBe(1);
    });

    it('2.4 no deberia permitir alterar el registro desde el conjunto devuelto', () => {
      // 1. Arrange: se devuelve una copia y no una vista del Map interno, porque
      //    un `ReadonlyMap` se recupera mutable con un simple cast.
      const factory = buildFactory();
      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_CRON));

      // 2. Act
      const registered = factory.getRegisteredNodeTypes() as Set<NodeType>;
      registered.add(NodeType.PROCESADOR_IA);

      // 3. Assert
      expect(factory.getRegisteredNodeTypes().has(NodeType.PROCESADOR_IA)).toBe(
        false,
      );
    });
  });
});
