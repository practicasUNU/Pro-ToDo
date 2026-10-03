import { ForbiddenException } from '@nestjs/common';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { UserRole } from '@modules/users/enums/user-role.enum';

import { assertModelPermissions } from './model-permissions.validator';

import type { PipelineSchema } from '@core/fsm/types/pipeline-schema.types';

/**
 * Suite de la barrera de modelos de pago.
 *
 * Lo que se fija aqui es el control de COSTE, no la forma del grafo: elegir un
 * modelo facturable compromete presupuesto en cada ejecucion del flujo, y esa
 * decision es de administracion. La interfaz tambien lo impide, pero eso es
 * comodidad —el cliente se puede saltar—; esta funcion es la que decide.
 */

/** Lo que el catalogo marca hoy como reservado. Doblado para no depender de el. */
const ADMIN_ONLY = new Set(['claude-haiku-4-5', 'claude-opus-5-5']);

const buildSchema = (
  nodeType: NodeType,
  params: Record<string, unknown>,
  nodeId = 'paso_ia',
): PipelineSchema => ({
  version: '1.0.0',
  flowId: 'f1e2d3c4-b5a6-4789-9012-3456789abcde',
  name: 'Flujo de prueba',
  entrypoint: nodeId,
  nodes: {
    [nodeId]: {
      nodeId,
      nodeType,
      outputNamespace: 'salida',
      nextStep: null,
      onErrorStep: null,
      params,
    },
  },
});

describe('assertModelPermissions · modelos de pago reservados al ADMIN', () => {
  describe('1. Rol EDITOR', () => {
    it('1.1 deberia rechazar claude-haiku-4-5 en un nodo PROCESADOR_OCR', () => {
      // 1. Arrange 📐: el caso que motivo la barrera.
      const schema = buildSchema(
        NodeType.PROCESADOR_OCR,
        { model: 'claude-haiku-4-5' },
        'ocr_rescate',
      );

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(() =>
        assertModelPermissions(schema, UserRole.EDITOR, ADMIN_ONLY),
      ).toThrow(ForbiddenException);
    });

    it('1.2 deberia rechazarlo TAMBIEN en el nodo PROCESADOR_IA', () => {
      // 1. Arrange 📐: restringir el modelo mas barato de Anthropic en OCR
      //    mientras el nodo de al lado admite `claude-opus-5-5` no seria un
      //    control de coste, seria un cartel.
      const schema = buildSchema(NodeType.PROCESADOR_IA, {
        model: 'claude-opus-5-5',
      });

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(() =>
        assertModelPermissions(schema, UserRole.EDITOR, ADMIN_ONLY),
      ).toThrow(ForbiddenException);
    });

    it('1.3 deberia nombrar el paso y el modelo en el mensaje', () => {
      // 1. Arrange 📐: un 403 generico sobre un pipeline de ocho pasos obliga
      //    a revisarlos uno a uno para averiguar cual sobra.
      const schema = buildSchema(
        NodeType.PROCESADOR_OCR,
        { model: 'claude-haiku-4-5' },
        'ocr_rescate',
      );

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(() =>
        assertModelPermissions(schema, UserRole.EDITOR, ADMIN_ONLY),
      ).toThrow(/ocr_rescate/);
      expect(() =>
        assertModelPermissions(schema, UserRole.EDITOR, ADMIN_ONLY),
      ).toThrow(/claude-haiku-4-5/);
    });

    it('1.4 deberia dejar pasar gemini-1.5-flash', () => {
      // 1. Arrange 📐: el free tier es coste cero, y es con lo que un EDITOR
      //    tiene que poder trabajar sin pedir permiso a nadie.
      const schema = buildSchema(NodeType.PROCESADOR_OCR, {
        model: 'gemini-1.5-flash',
      });

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(() =>
        assertModelPermissions(schema, UserRole.EDITOR, ADMIN_ONLY),
      ).not.toThrow();
    });

    it('1.5 deberia ignorar los nodos que no consumen un LLM', () => {
      // 1. Arrange 📐: comprobar "todo nodo que tenga un campo model" habria
      //    prohibido configuraciones que no gastan un euro.
      const schema = buildSchema(NodeType.DESTINO_HTTP, {
        model: 'claude-opus-5-5',
      });

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(() =>
        assertModelPermissions(schema, UserRole.EDITOR, ADMIN_ONLY),
      ).not.toThrow();
    });

    it('1.6 deberia dejar pasar un nodo de IA sin model declarado', () => {
      // 1. Arrange 📐: sin `model` manda el defecto del DTO, que es gratuito.
      const schema = buildSchema(NodeType.PROCESADOR_IA, {});

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(() =>
        assertModelPermissions(schema, UserRole.EDITOR, ADMIN_ONLY),
      ).not.toThrow();
    });
  });

  describe('2. Rol ADMIN', () => {
    it('2.1 deberia poder usar cualquier modelo del catalogo', () => {
      // 1. Arrange 📐
      const schema = buildSchema(NodeType.PROCESADOR_OCR, {
        model: 'claude-haiku-4-5',
      });

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(() =>
        assertModelPermissions(schema, UserRole.ADMIN, ADMIN_ONLY),
      ).not.toThrow();
    });
  });
});
