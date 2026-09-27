import { describe, expect, it } from 'vitest';

import {
  assemblePipelineSchema,
  collectErrorSatellites,
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
    it('1.4 deberia dejar onErrorStep en null en un paso que no declara rama', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const schema = assemblePipelineSchema([TRIGGER, PARSER, MAPPER], META);

      // 3. Assert 🎯: `null` es el defecto CORRECTO, no una limitacion. El motor
      //    detiene la ejecucion en el nodo que falla, que es lo que debe pasar
      //    mientras nadie declare a donde desviarse.
      expect(Object.values(schema.nodes).every((node) => node.onErrorStep === null)).toBe(true);
    });

    it('1.4bis deberia emitir la ruta que declara el paso, en sus dos formas', () => {
      // 1. Arrange 📐: la cadena atrapa cualquier codigo; el objeto selectivo
      //    solo los que nombra. Son formas distintas, no estilos.
      const schema = assemblePipelineSchema(
        [
          { ...TRIGGER, onErrorStep: 'alerta_smtp' },
          {
            ...PARSER,
            onErrorStep: {
              targetNode: 'alerta_smtp',
              catchErrors: ['ERR_PARSER_UNEXTRACTABLE_MEDIA'],
            },
          },
          MAPPER,
        ],
        META,
      );

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(schema.nodes.trigger_imap?.onErrorStep).toBe('alerta_smtp');
      expect(schema.nodes.parser_pre_ia?.onErrorStep).toEqual({
        targetNode: 'alerta_smtp',
        catchErrors: ['ERR_PARSER_UNEXTRACTABLE_MEDIA'],
      });
      expect(schema.nodes.mapeador_plantilla?.onErrorStep).toBeNull();
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

  describe('1bis. Nodos satelite', () => {
    const ALERT = step('alerta_smtp', NodeType.DESTINO_SMTP, { to: ['guardia@unuware.com'] });

    it('1bis.1 deberia emitirlos como nodos terminales', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const schema = assemblePipelineSchema([TRIGGER, MAPPER], META, [ALERT]);

      // 3. Assert 🎯
      expect(schema.nodes.alerta_smtp?.nextStep).toBeNull();
      expect(schema.nodes.alerta_smtp?.params).toEqual({ to: ['guardia@unuware.com'] });
    });

    it('1bis.2 NO deberia meterlos en el encadenado del camino activo', () => {
      // 1. Arrange 📐: el encadenado es posicional. Un satelite colado entre los
      //    pasos heredaria un `nextStep` y se ejecutaria en cada pasada, no solo
      //    cuando algo falla.
      const schema = assemblePipelineSchema([TRIGGER, MAPPER], META, [ALERT]);

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(schema.nodes.trigger_imap?.nextStep).toBe('mapeador_plantilla');
      expect(schema.nodes.mapeador_plantilla?.nextStep).toBeNull();
      expect(schema.entrypoint).toBe('trigger_imap');
    });

    it('1bis.3 no deberia pisar un paso del camino activo con el mismo nodeId', () => {
      // 1. Arrange 📐: si el flujo YA termina en un nodo de alerta, ese nodo es
      //    un paso y no un satelite. Sobrescribirlo con uno terminal partiria el
      //    flujo en dos sin ningun aviso.
      const destination = step('alerta_smtp', NodeType.DESTINO_SMTP, { to: ['real@unuware.com'] });

      // 2. Act ⚙️
      const schema = assemblePipelineSchema([TRIGGER, destination], META, [ALERT]);

      // 3. Assert 🎯
      expect(schema.nodes.alerta_smtp?.params).toEqual({ to: ['real@unuware.com'] });
      expect(schema.nodes.trigger_imap?.nextStep).toBe('alerta_smtp');
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

      // 3. Assert: la ida y vuelta devuelve los pasos con su ruta RESUELTA. Los
      //    fixtures no la declaran, asi que vuelven con `null` explicito: el
      //    desensamblador informa del dato, no lo omite por estar vacio.
      expect(steps).toEqual(
        [TRIGGER, PARSER, MAPPER].map((step) => ({ ...step, onErrorStep: null })),
      );
    });

    it('4.1bis deberia CONSERVAR la ruta de error en la ida y vuelta', () => {
      // 1. Arrange 📐: REGRESION. `AssemblerStep` no declaraba `onErrorStep`, asi
      //    que un assemble -> disassemble -> assemble lo reescribia a `null`:
      //    abrir una plantilla con una ruta escrita a mano en el panel JSON y
      //    volver a guardarla la borraba en silencio.
      const branched = {
        ...PARSER,
        onErrorStep: {
          targetNode: 'alerta_smtp',
          catchErrors: ['ERR_PARSER_UNEXTRACTABLE_MEDIA'],
        },
      };
      const original = assemblePipelineSchema([TRIGGER, branched, MAPPER], META);

      // 2. Act ⚙️
      const roundTripped = assemblePipelineSchema(disassemblePipelineSchema(original), META);

      // 3. Assert 🎯
      expect(roundTripped.nodes.parser_pre_ia?.onErrorStep).toEqual({
        targetNode: 'alerta_smtp',
        catchErrors: ['ERR_PARSER_UNEXTRACTABLE_MEDIA'],
      });
    });

    it('4.1ter deberia recuperar los satelites que el recorrido no visita', () => {
      // 1. Arrange 📐: un nodo de alerta no esta en el camino de `nextStep`, asi
      //    que el desensamblador no lo ve. Sin recuperarlo, al reensamblar la
      //    ruta apuntaria a un nodo que ya no existe en el mapa y el backend lo
      //    rechazaria con su regla 3.
      const original = assemblePipelineSchema(
        [TRIGGER, { ...MAPPER, onErrorStep: 'alerta_smtp' }],
        META,
        [step('alerta_smtp', NodeType.DESTINO_SMTP, { to: ['guardia@unuware.com'] })],
      );

      // 2. Act ⚙️
      const steps = disassemblePipelineSchema(original);
      const satellites = collectErrorSatellites(original, steps);

      // 3. Assert 🎯
      expect(steps.map((item) => item.nodeId)).toEqual(['trigger_imap', 'mapeador_plantilla']);
      expect(satellites).toHaveLength(1);
      expect(satellites[0]?.nodeId).toBe('alerta_smtp');

      const rebuilt = assemblePipelineSchema(steps, META, satellites);

      expect(rebuilt.nodes.alerta_smtp?.nextStep).toBeNull();
      expect(rebuilt.nodes.mapeador_plantilla?.onErrorStep).toBe('alerta_smtp');
    });

    it('4.1quater NO deberia tratar como satelite un desvio hacia atras', () => {
      // 1. Arrange 📐: apuntar a un nodo ANTERIOR es el patron legitimo de
      //    reintento por otro camino, y ese nodo ya esta en la secuencia.
      const original = assemblePipelineSchema(
        [TRIGGER, { ...MAPPER, onErrorStep: 'trigger_imap' }],
        META,
      );

      // 2. Act ⚙️
      const steps = disassemblePipelineSchema(original);

      // 3. Assert 🎯
      expect(collectErrorSatellites(original, steps)).toEqual([]);
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
