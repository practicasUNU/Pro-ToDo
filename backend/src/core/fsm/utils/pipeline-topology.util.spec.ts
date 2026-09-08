import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { buildOrderedTopology } from '@core/fsm/utils/pipeline-topology.util';

import type {
  PipelineNodeConfig,
  PipelineSchema,
} from '@core/fsm/types/pipeline-schema.types';

/** Nodo minimo; cada prueba sobreescribe lo que le concierne. */
const buildNode = (
  overrides: Partial<PipelineNodeConfig> & Pick<PipelineNodeConfig, 'nodeId'>,
): PipelineNodeConfig => ({
  nodeType: NodeType.TRIGGER_IMAP,
  outputNamespace: 'raw_email',
  nextStep: null,
  onErrorStep: null,
  params: {},
  ...overrides,
});

const buildSchema = (
  entrypoint: string,
  nodes: PipelineNodeConfig[],
): PipelineSchema => ({
  flowId: 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  name: 'Pipeline de prueba',
  version: '1.0.0',
  entrypoint,
  nodes: Object.fromEntries(nodes.map((node) => [node.nodeId, node])),
});

describe('buildOrderedTopology', () => {
  describe('1. Orden de ejecucion', () => {
    it('1.1 deberia recorrer el grafo desde entrypoint siguiendo nextStep', () => {
      // 1. Arrange: las claves del mapa van en orden INVERSO al de ejecucion, que
      //    es lo que distingue el recorrido real de un Object.values().
      const schema = buildSchema('trigger', [
        buildNode({
          nodeId: 'destino',
          nodeType: NodeType.DESTINO_HTTP,
          outputNamespace: 'destino_http',
        }),
        buildNode({
          nodeId: 'mapeador',
          nodeType: NodeType.MAPEADOR_PLANTILLA,
          outputNamespace: 'rendered_html',
          nextStep: 'destino',
        }),
        buildNode({ nodeId: 'trigger', nextStep: 'mapeador' }),
      ]);

      // 2. Act
      const steps = buildOrderedTopology(schema);

      // 3. Assert
      expect(steps.map((step) => step.nodeId)).toEqual([
        'trigger',
        'mapeador',
        'destino',
      ]);
    });

    it('1.2 deberia proyectar solo nodeId, nodeType y outputNamespace', () => {
      // 1. Arrange: `params` con datos de infraestructura que no deben viajar.
      const schema = buildSchema('trigger', [
        buildNode({
          nodeId: 'trigger',
          params: { host: 'imap.unuware.com', passwordEnvKey: 'IMAP_PASSWORD' },
        }),
      ]);

      // 2. Act
      const steps = buildOrderedTopology(schema);

      // 3. Assert
      expect(steps).toEqual([
        {
          nodeId: 'trigger',
          nodeType: NodeType.TRIGGER_IMAP,
          outputNamespace: 'raw_email',
        },
      ]);
    });

    it('1.3 deberia devolver una lista vacia si el entrypoint no existe', () => {
      // 1. Arrange
      const schema = buildSchema('nodo_fantasma', [
        buildNode({ nodeId: 'trigger' }),
      ]);

      // 2. Act
      const steps = buildOrderedTopology(schema);

      // 3. Assert
      expect(steps).toEqual([]);
    });
  });

  describe('2. Esquemas rotos', () => {
    it('2.1 deberia cortar el recorrido ante un ciclo sin colgarse', () => {
      // 1. Arrange: ciclo que `validatePipelineTopology` rechazaria, pero que una
      //    fila escrita por SQL directo puede tener.
      const schema = buildSchema('a', [
        buildNode({ nodeId: 'a', nextStep: 'b' }),
        buildNode({ nodeId: 'b', nextStep: 'a' }),
      ]);

      // 2. Act
      const steps = buildOrderedTopology(schema);

      // 3. Assert: cada nodo aparece UNA vez y la funcion termina.
      expect(steps.map((step) => step.nodeId)).toEqual(['a', 'b']);
    });

    it('2.2 deberia truncar en un puntero huerfano y devolver lo acumulado', () => {
      // 1. Arrange
      const schema = buildSchema('a', [
        buildNode({ nodeId: 'a', nextStep: 'nodo_inexistente' }),
      ]);

      // 2. Act
      const steps = buildOrderedTopology(schema);

      // 3. Assert: no lanza. El catalogo debe seguir respondiendo para que el
      //    operador pueda ver el esquema roto y arreglarlo.
      expect(steps.map((step) => step.nodeId)).toEqual(['a']);
    });

    it('2.3 deberia avisar al llamante con el nodeId huerfano', () => {
      // 1. Arrange
      const schema = buildSchema('a', [
        buildNode({ nodeId: 'a', nextStep: 'nodo_inexistente' }),
      ]);
      const onTruncated = jest.fn();

      // 2. Act
      buildOrderedTopology(schema, onTruncated);

      // 3. Assert: el registro es del llamante, que es quien sabe si el esquema
      //    roto es de un flujo o de una plantilla.
      expect(onTruncated).toHaveBeenCalledTimes(1);
      expect(onTruncated).toHaveBeenCalledWith('nodo_inexistente');
    });

    it('2.4 no deberia invocar el aviso en un grafo completo', () => {
      // 1. Arrange
      const schema = buildSchema('a', [buildNode({ nodeId: 'a' })]);
      const onTruncated = jest.fn();

      // 2. Act
      buildOrderedTopology(schema, onTruncated);

      // 3. Assert
      expect(onTruncated).not.toHaveBeenCalled();
    });
  });
});
