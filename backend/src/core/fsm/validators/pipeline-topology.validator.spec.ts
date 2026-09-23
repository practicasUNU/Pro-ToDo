import { NodeType } from '@core/fsm/types/pipeline-schema.types';

import { validatePipelineTopology } from './pipeline-topology.validator';

import type { PipelineSchemaDto } from '@core/fsm/dto/pipeline-schema.dto';
import type { SchemaIssue } from './pipeline-topology.validator';

/**
 * Prueba DIRECTA de la funcion pura, complementaria a la de
 * `PipelineValidatorService`.
 *
 * Aquella la ejercita a traves del servicio, que antes valida forma y tipos con
 * class-validator y solo entonces llama aqui. Eso hace imposible llegar a estas
 * reglas con un esquema deliberadamente roto —el DTO lo rechaza antes—, y por
 * eso esta suite invoca la funcion sin intermediario: es la unica forma de
 * comprobar que cada regla dispara por si sola y no por arrastre de otra.
 *
 * La funcion NO es una clase ni devuelve `{ valid, errors }`: devuelve un
 * arreglo de `SchemaIssue` con `field` (notacion con punto, para que el
 * asistente senale el control exacto) y `constraints`. Un arreglo vacio significa
 * que el grafo es integro.
 */

/** Atajo para aseverar sobre las rutas de los campos invalidos. */
const fieldsOf = (issues: SchemaIssue[]): string[] =>
  issues.map((issue) => issue.field);

/**
 * Pipeline lineal minimo y VALIDO: disparador -> parser -> extractor.
 *
 * Devuelve un literal nuevo en cada llamada para que cada prueba mute su propia
 * copia sin contaminar a las demas.
 */
const buildSchema = (): PipelineSchemaDto => ({
  flowId: 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  name: 'Pipeline de prueba',
  version: '1.0.0',
  entrypoint: 'nodo_trigger',
  nodes: {
    nodo_trigger: {
      nodeId: 'nodo_trigger',
      nodeType: NodeType.TRIGGER_IMAP,
      outputNamespace: 'raw_email',
      nextStep: 'nodo_parser',
      onErrorStep: null,
      params: {},
    },
    nodo_parser: {
      nodeId: 'nodo_parser',
      nodeType: NodeType.PARSER_PRE_IA,
      outputNamespace: 'parsed_email',
      nextStep: 'nodo_extractor',
      onErrorStep: null,
      params: {},
    },
    nodo_extractor: {
      nodeId: 'nodo_extractor',
      nodeType: NodeType.EXTRACTOR_WEB,
      outputNamespace: 'scraped_web',
      nextStep: null,
      onErrorStep: null,
      params: { targetUrl: '{{parsed_email.extracted_urls[0]}}' },
    },
  },
});

describe('validatePipelineTopology', () => {
  describe('0. Grafo integro', () => {
    it('0.1 no deberia reportar nada sobre un pipeline lineal correcto', () => {
      // 1. Arrange & 2. Act
      const issues = validatePipelineTopology(buildSchema());

      // 3. Assert
      expect(issues).toEqual([]);
    });
  });

  describe('1. Entrypoint existente', () => {
    it('1.1 deberia rechazar un entrypoint que no esta en el mapa', () => {
      // 1. Arrange
      const schema = buildSchema();
      schema.entrypoint = 'nodo_fantasma';

      // 2. Act
      const issues = validatePipelineTopology(schema);

      // 3. Assert: sin punto de partida real el motor no sabria ni por donde
      //    empezar, asi que este fallo va antes que cualquier otro.
      expect(fieldsOf(issues)).toContain('entrypoint');
    });
  });

  describe('2. Coherencia entre la clave del mapa y el nodeId', () => {
    it('2.1 deberia rechazar una clave distinta del nodeId que declara el nodo', () => {
      // 1. Arrange
      const schema = buildSchema();
      schema.nodes.nodo_parser.nodeId = 'otro_nombre';

      // 2. Act
      const issues = validatePipelineTopology(schema);

      // 3. Assert: el motor indexa por CLAVE y la estrategia lee `nodeId`;
      //    desincronizarlos deja dos identidades para el mismo nodo.
      expect(fieldsOf(issues)).toContain('nodes.nodo_parser.nodeId');
    });
  });

  describe('3. Punteros que resuelven', () => {
    it('3.1 deberia rechazar un nextStep hacia un nodo inexistente', () => {
      // 1. Arrange
      const schema = buildSchema();
      schema.nodes.nodo_parser.nextStep = 'nodo_fantasma';

      // 2. Act
      const issues = validatePipelineTopology(schema);

      // 3. Assert
      expect(fieldsOf(issues)).toContain('nodes.nodo_parser.nextStep');
    });

    it('3.2 deberia rechazar un onErrorStep hacia un nodo inexistente', () => {
      // 1. Arrange
      const schema = buildSchema();
      schema.nodes.nodo_parser.onErrorStep = 'nodo_fantasma';

      // 2. Act
      const issues = validatePipelineTopology(schema);

      // 3. Assert
      expect(fieldsOf(issues)).toContain('nodes.nodo_parser.onErrorStep');
    });

    it('3.3 deberia validar el destino DECLARADO de una ruta selectiva', () => {
      // 1. Arrange
      const schema = buildSchema();
      schema.nodes.nodo_parser.onErrorStep = {
        targetNode: 'nodo_fantasma',
        catchErrors: ['ERR_PARSER_CONFIG'],
      };

      // 2. Act
      const issues = validatePipelineTopology(schema);

      // 3. Assert: que la ruta atrape unos codigos u otros es indiferente aqui.
      //    Apuntar a un nodo inexistente rompe el esquema aunque ese codigo no
      //    llegue a ocurrir jamas.
      expect(fieldsOf(issues)).toContain('nodes.nodo_parser.onErrorStep');
    });

    it('3.4 deberia aceptar un onErrorStep que apunta hacia atras', () => {
      // 1. Arrange: es el patron legitimo de reintento o recuperacion, y por eso
      //    las rutas de error quedan fuera de la deteccion de ciclos.
      const schema = buildSchema();
      schema.nodes.nodo_extractor.onErrorStep = 'nodo_parser';

      // 2. Act
      const issues = validatePipelineTopology(schema);

      // 3. Assert
      expect(issues).toEqual([]);
    });
  });

  describe('4. Namespaces de salida permitidos', () => {
    it('4.1 deberia rechazar un outputNamespace fuera de la lista blanca', () => {
      // 1. Arrange: el formato ya lo comprueba el DTO; aqui se comprueba la
      //    PERTENENCIA. Un namespace bien formado pero desconocido pasaria el
      //    esquema y solo reventaria al guardar una plantilla que lo interpola.
      const schema = buildSchema();
      schema.nodes.nodo_parser.outputNamespace = 'namespace_inventado';

      // 2. Act
      const issues = validatePipelineTopology(schema);

      // 3. Assert
      expect(fieldsOf(issues)).toContain('nodes.nodo_parser.outputNamespace');
    });
  });

  describe('5. Unicidad del namespace de salida', () => {
    it('5.1 deberia rechazar dos nodos que escriben en el mismo namespace', () => {
      // 1. Arrange
      const schema = buildSchema();
      schema.nodes.nodo_extractor.outputNamespace = 'parsed_email';

      // 2. Act
      const issues = validatePipelineTopology(schema);

      // 3. Assert: dos escritores del mismo namespace romperian la
      //    inmutabilidad del `StatePayloadContext`.
      expect(fieldsOf(issues)).toContain(
        'nodes.nodo_extractor.outputNamespace',
      );
    });
  });

  describe('6. Ausencia de ciclos en el camino activo', () => {
    it('6.1 deberia rechazar un ciclo siguiendo nextStep', () => {
      // 1. Arrange: extractor -> parser -> extractor.
      const schema = buildSchema();
      schema.nodes.nodo_extractor.nextStep = 'nodo_parser';

      // 2. Act
      const issues = validatePipelineTopology(schema);

      // 3. Assert
      expect(issues).toHaveLength(1);
      expect(issues[0].constraints[0]).toContain('ciclo infinito');
    });

    it('6.2 deberia aceptar un nodo huerfano inalcanzable desde el entrypoint', () => {
      // 1. Arrange: un flujo puede conservar ramas en construccion sin que eso
      //    invalide el esquema.
      const schema = buildSchema();
      schema.nodes.nodo_suelto = {
        nodeId: 'nodo_suelto',
        nodeType: NodeType.DESTINO_HTTP,
        outputNamespace: 'http_result',
        nextStep: null,
        onErrorStep: null,
        params: {},
      };

      // 2. Act
      const issues = validatePipelineTopology(schema);

      // 3. Assert
      expect(issues).toEqual([]);
    });
  });

  describe('7. Namespaces requeridos aguas arriba', () => {
    /**
     * Resolvedor de dependencias doblado.
     *
     * El validador lo recibe como PARAMETRO y no lo importa, que es lo que le
     * permite seguir siendo una funcion pura. Aqui eso se cobra: un doble de dos
     * lineas basta, sin factoria de estrategias ni contenedor de Nest.
     */
    const requiring =
      (byType: Partial<Record<NodeType, readonly string[]>>) =>
      (node: { nodeType: NodeType }): readonly string[] =>
        byType[node.nodeType] ?? [];

    it('7.1 no deberia aplicarse si no se pasa el resolvedor', () => {
      // 1. Arrange: el parametro es opcional, y omitirlo desactiva la regla.
      //    Es lo que hacen las pruebas de las otras seis.
      const schema = buildSchema();
      schema.entrypoint = 'nodo_extractor';
      schema.nodes.nodo_extractor.nextStep = null;

      // 2. Act
      const issues = validatePipelineTopology(schema);

      // 3. Assert
      expect(issues).toEqual([]);
    });

    it('7.2 deberia rechazar un nodo cuyo namespace no lo escribe nadie antes', () => {
      // 1. Arrange: el extractor arranca el flujo, asi que nadie ha escrito
      //    `parsed_email` cuando le toca ejecutarse.
      const schema = buildSchema();
      schema.entrypoint = 'nodo_extractor';
      schema.nodes.nodo_extractor.nextStep = null;

      // 2. Act
      const issues = validatePipelineTopology(
        schema,
        requiring({ [NodeType.EXTRACTOR_WEB]: ['parsed_email'] }),
      );

      // 3. Assert: detectarlo al guardar es la diferencia entre corregirlo ahora
      //    o descubrirlo con el flujo PAUSADO en produccion.
      expect(fieldsOf(issues)).toContain('nodes.nodo_extractor.params');
      expect(issues[0].constraints[0]).toContain('parsed_email');
    });

    it('7.3 deberia aceptar el flujo cuando un paso anterior lo escribe', () => {
      // 1. Arrange & 2. Act: el orden correcto, con el parser por delante.
      const issues = validatePipelineTopology(
        buildSchema(),
        requiring({ [NodeType.EXTRACTOR_WEB]: ['parsed_email'] }),
      );

      // 3. Assert
      expect(issues).toEqual([]);
    });

    it('7.4 no deberia dar por escrito el namespace del propio nodo', () => {
      // 1. Arrange: un nodo no puede satisfacerse a si mismo. Su salida se
      //    acumula DESPUES de comprobarlo, y confundir el orden dejaria pasar
      //    cualquier autodependencia.
      const schema = buildSchema();

      // 2. Act
      const issues = validatePipelineTopology(
        schema,
        requiring({ [NodeType.PARSER_PRE_IA]: ['parsed_email'] }),
      );

      // 3. Assert
      expect(fieldsOf(issues)).toContain('nodes.nodo_parser.params');
    });

    it('7.5 no deberia juzgar un nodo alcanzable solo por onErrorStep', () => {
      // 1. Arrange: se descuelga el extractor del camino activo y se deja
      //    colgado de una ruta de error.
      const schema = buildSchema();
      schema.nodes.nodo_parser.nextStep = null;
      schema.nodes.nodo_parser.onErrorStep = 'nodo_extractor';

      // 2. Act
      const issues = validatePipelineTopology(
        schema,
        requiring({ [NodeType.EXTRACTOR_WEB]: ['llm_response'] }),
      );

      // 3. Assert: sus predecesores cambian segun por donde se entre, asi que
      //    afirmar algo sobre el al guardar seria adivinar. Lo cubre la guarda
      //    del motor, que si sabe que contexto hay de verdad.
      expect(issues).toEqual([]);
    });

    it('7.6 no deberia exigir los namespaces que siembra el propio motor', () => {
      // 1. Arrange & 2. Act: `trigger` lo escribe el motor con el
      //    `initialPayload` y `_assets` lo inyecta el renderizador; ningun nodo
      //    los declara como salida.
      const issues = validatePipelineTopology(
        buildSchema(),
        requiring({ [NodeType.PARSER_PRE_IA]: ['trigger', '_assets'] }),
      );

      // 3. Assert: exigir que algun nodo los produzca los haria irresolubles por
      //    construccion.
      expect(issues).toEqual([]);
    });

    it('7.7 deberia nombrar todos los namespaces que faltan a la vez', () => {
      // 1. Arrange & 2. Act
      const issues = validatePipelineTopology(
        buildSchema(),
        requiring({
          [NodeType.PARSER_PRE_IA]: ['llm_response', 'http_result'],
        }),
      );

      // 3. Assert: un mensaje por namespace obligaria al operador a corregir,
      //    reguardar y volver a fallar por el siguiente.
      expect(issues[0].constraints[0]).toContain('llm_response');
      expect(issues[0].constraints[0]).toContain('http_result');
    });

    it('7.8 deberia rechazar TRIGGER_CRON -> EXTRACTOR_WEB al guardar', () => {
      // 1. Arrange: se sustituye el disparador IMAP por uno de reloj y se
      //    elimina el parser. El extractor queda justo detras del cron.
      const schema = buildSchema();

      schema.nodes.nodo_trigger.nodeType = NodeType.TRIGGER_CRON;
      schema.nodes.nodo_trigger.outputNamespace = 'cron_trigger';
      schema.nodes.nodo_trigger.nextStep = 'nodo_extractor';
      delete schema.nodes.nodo_parser;

      // 2. Act: el extractor necesita `parsed_email` porque asi lo dice su
      //    `targetUrl`, y el cron solo escribe `cron_trigger`.
      const issues = validatePipelineTopology(
        schema,
        requiring({ [NodeType.EXTRACTOR_WEB]: ['parsed_email'] }),
      );

      // 3. Assert: el rechazo ocurre AL GUARDAR y no en la primera ejecucion.
      //    El codigo es el mismo que emite el motor ante la misma causa, para
      //    que el asistente pueda conmutar sobre el y no sobre el texto.
      expect(fieldsOf(issues)).toEqual(['nodes.nodo_extractor.params']);
      expect(issues[0].code).toBe('ERR_MISSING_UPSTREAM_CONTEXT');
      expect(issues[0].constraints[0]).toContain('parsed_email');
    });

    it('7.9 no deberia poner codigo en las incidencias de otras reglas', () => {
      // 1. Arrange
      const schema = buildSchema();

      schema.nodes.nodo_parser.nextStep = 'nodo_inexistente';

      // 2. Act
      const issues = validatePipelineTopology(schema);

      // 3. Assert: `code` es OPCIONAL y solo lo declara la regla 7. Si alguna
      //    otra empezase a rellenarlo sin acordarlo, el cliente conmutaria
      //    sobre un valor que nadie documento.
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBeUndefined();
    });
  });
});
