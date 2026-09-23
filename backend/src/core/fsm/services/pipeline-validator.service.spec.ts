import { BadRequestException } from '@nestjs/common';

import { PipelineSchemaDto } from '@core/fsm/dto/pipeline-schema.dto';
import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import { PipelineValidatorService } from '@core/fsm/services/pipeline-validator.service';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';

import type { PipelineSchema } from '@core/fsm/types/pipeline-schema.types';
import type { SchemaIssue } from '@core/fsm/validators/pipeline-topology.validator';

/**
 * Pipeline completo de Notiweb: los 7 tipos de nodo encadenados desde el trigger
 * IMAP hasta la publicacion HTTP. Devuelve un literal nuevo en cada llamada, de
 * modo que cada prueba muta su propia copia sin contaminar a las demas.
 */
const buildNotiwebSchema = (): PipelineSchema => ({
  flowId: 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  name: 'Notiweb - publicacion automatica',
  version: '1.0.0',
  entrypoint: 'trigger_imap',
  nodes: {
    trigger_imap: {
      nodeId: 'trigger_imap',
      nodeType: NodeType.TRIGGER_IMAP,
      outputNamespace: 'raw_email',
      nextStep: 'nodo_parser',
      onErrorStep: null,
      params: { host: 'imap.unuware.com', folder: 'INBOX' },
    },
    nodo_parser: {
      nodeId: 'nodo_parser',
      nodeType: NodeType.PARSER_PRE_IA,
      outputNamespace: 'parsed_email',
      nextStep: 'nodo_extractor',
      onErrorStep: null,
      params: { stripSignatures: true },
    },
    nodo_extractor: {
      nodeId: 'nodo_extractor',
      nodeType: NodeType.EXTRACTOR_WEB,
      outputNamespace: 'scraped_web',
      nextStep: 'nodo_ia',
      onErrorStep: null,
      retryPolicy: { maxRetries: 3, backoffMs: 1000, backoffFactor: 2 },
      params: { selector: 'article' },
    },
    nodo_ia: {
      nodeId: 'nodo_ia',
      nodeType: NodeType.PROCESADOR_IA,
      outputNamespace: 'llm_response',
      nextStep: 'nodo_escudo',
      onErrorStep: null,
      retryPolicy: { maxRetries: 2 },
      params: { promptKey: 'extract_news' },
    },
    nodo_escudo: {
      nodeId: 'nodo_escudo',
      nodeType: NodeType.ESCUDO_POST_IA,
      outputNamespace: 'validated_drupal_json',
      nextStep: 'nodo_mapeador',
      onErrorStep: null,
      params: { schemaId: 'noticia_v1' },
    },
    nodo_mapeador: {
      nodeId: 'nodo_mapeador',
      nodeType: NodeType.MAPEADOR_PLANTILLA,
      outputNamespace: 'rendered_html',
      nextStep: 'nodo_destino',
      onErrorStep: null,
      params: { templateId: 'tpl-1' },
    },
    nodo_destino: {
      nodeId: 'nodo_destino',
      nodeType: NodeType.DESTINO_HTTP,
      outputNamespace: 'http_result',
      nextStep: null,
      onErrorStep: null,
      params: { url: 'https://drupal.unuware.com/jsonapi/node/article' },
    },
  },
});

/** Ejecuta la validacion esperando el rechazo y devuelve los issues del cuerpo. */
const captureIssues = async (
  service: PipelineValidatorService,
  schema: unknown,
): Promise<SchemaIssue[]> => {
  try {
    await service.validateSchema(schema);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);

    const { issues } = (error as BadRequestException).getResponse() as {
      issues: SchemaIssue[];
    };

    return issues;
  }

  throw new Error(
    'Se esperaba un BadRequestException y la validacion no fallo.',
  );
};

/** Atajo para aseverar sobre las rutas de los campos invalidos. */
const fieldsOf = (issues: SchemaIssue[]): string[] =>
  issues.map((issue) => issue.field);

describe('PipelineValidatorService (PROT-07)', () => {
  let service: PipelineValidatorService;

  beforeEach(() => {
    // Factoria VACIA a proposito: sin estrategias registradas, todos los nodos
    // declaran cero dependencias y la regla 7 no interviene. Estas pruebas
    // examinan las otras seis reglas, y sembrar estrategias aqui las acoplaria a
    // la configuracion de unos nodos que no vienen al caso. La regla 7 tiene su
    // propio bloque, con su doble.
    service = new PipelineValidatorService(new NodeStrategyFactory());
  });

  describe('esquema valido', () => {
    it('deberia validar el pipeline completo de Notiweb con sus 7 nodos', async () => {
      // 1. Arrange
      const schema = buildNotiwebSchema();

      // 2. Act
      const result = await service.validateSchema(schema);

      // 3. Assert
      expect(result).toBeInstanceOf(PipelineSchemaDto);
      expect(Object.keys(result.nodes)).toHaveLength(7);
      expect(result.entrypoint).toBe('trigger_imap');
    });

    it('deberia aceptar un nodo huerfano inalcanzable desde el entrypoint', async () => {
      // 1. Arrange: rama en construccion que nadie referencia todavia
      const schema = buildNotiwebSchema();
      schema.nodes.nodo_huerfano = {
        nodeId: 'nodo_huerfano',
        nodeType: NodeType.EXTRACTOR_WEB,
        outputNamespace: 'cron_trigger',
        nextStep: null,
        onErrorStep: null,
        params: {},
      };

      // 2. Act
      const result = await service.validateSchema(schema);

      // 3. Assert: la topologia es permisiva con lo inalcanzable
      expect(Object.keys(result.nodes)).toHaveLength(8);
    });

    it('deberia aceptar un onErrorStep que apunta hacia atras (reintento)', async () => {
      // 1. Arrange: solo los ciclos de `nextStep` estan prohibidos
      const schema = buildNotiwebSchema();
      schema.nodes.nodo_ia.onErrorStep = 'nodo_parser';

      // 2. Act
      const result = await service.validateSchema(schema);

      // 3. Assert
      expect(result.nodes.nodo_ia.onErrorStep).toBe('nodo_parser');
    });
  });

  describe('integridad topologica', () => {
    it('deberia rechazar un camino activo sin nodo terminal (ciclo en nextStep)', async () => {
      // 1. Arrange: el ultimo nodo vuelve al procesador de IA
      const schema = buildNotiwebSchema();
      schema.nodes.nodo_destino.nextStep = 'nodo_ia';

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert
      expect(fieldsOf(issues)).toContain('nodes.nodo_destino.nextStep');
      expect(issues[0].constraints[0]).toContain('ciclo infinito');
    });

    it('deberia rechazar dos nodos que escriben en el mismo outputNamespace', async () => {
      // 1. Arrange
      const schema = buildNotiwebSchema();
      schema.nodes.nodo_extractor.outputNamespace = 'parsed_email';

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert
      expect(fieldsOf(issues)).toContain(
        'nodes.nodo_extractor.outputNamespace',
      );
      expect(issues[0].constraints[0]).toContain('nodo_parser');
    });

    it('deberia rechazar un outputNamespace fuera de la lista blanca', async () => {
      // 1. Arrange: `resultado_ia` respeta el formato snake_case del DTO, asi
      // que solo esta regla puede detenerlo. Sin ella pasaria la validacion y
      // reventaria mas tarde, al guardar una plantilla que lo interpola.
      const schema = buildNotiwebSchema();
      schema.nodes.nodo_ia.outputNamespace = 'resultado_ia';

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert
      expect(fieldsOf(issues)).toContain('nodes.nodo_ia.outputNamespace');
      expect(issues[0].constraints[0]).toContain('no esta permitido');
    });

    it('deberia aceptar una ruta de error selectiva', async () => {
      // 1. Arrange
      const schema = buildNotiwebSchema();
      schema.nodes.nodo_ia.onErrorStep = {
        targetNode: 'nodo_destino',
        catchErrors: ['ERR_LLM_TIMEOUT'],
      };

      // 2. Act
      const result = await service.validateSchema(schema);

      // 3. Assert
      expect(result.nodes.nodo_ia.onErrorStep).toEqual({
        targetNode: 'nodo_destino',
        catchErrors: ['ERR_LLM_TIMEOUT'],
      });
    });

    it('deberia aceptar una ruta selectiva con customMessage', async () => {
      // 1. Arrange
      const schema = buildNotiwebSchema();
      schema.nodes.nodo_ia.onErrorStep = {
        targetNode: 'nodo_destino',
        catchErrors: ['ERR_LLM_TIMEOUT'],
        customMessage: 'El proveedor de IA no respondio a tiempo.',
      };

      // 2. Act
      const result = await service.validateSchema(schema);

      // 3. Assert
      expect(result.nodes.nodo_ia.onErrorStep).toMatchObject({
        customMessage: 'El proveedor de IA no respondio a tiempo.',
      });
    });

    it('deberia rechazar un customMessage vacio', async () => {
      // 1. Arrange: declararlo en blanco sustituiria el mensaje real por nada,
      //    que es peor que no declararlo.
      const schema = buildNotiwebSchema();
      schema.nodes.nodo_ia.onErrorStep = {
        targetNode: 'nodo_destino',
        catchErrors: ['ERR_LLM_TIMEOUT'],
        customMessage: '   ',
      };

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert
      expect(fieldsOf(issues)).toContain('nodes.nodo_ia.onErrorStep');
    });

    it('deberia rechazar una ruta selectiva cuyo targetNode no existe', async () => {
      // 1. Arrange: un destino inexistente rompe el esquema aunque su codigo no
      //    llegue a ocurrir nunca, asi que se valida el destino DECLARADO.
      const schema = buildNotiwebSchema();
      schema.nodes.nodo_ia.onErrorStep = {
        targetNode: 'nodo_fantasma',
        catchErrors: ['ERR_LLM_TIMEOUT'],
      };

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert
      expect(fieldsOf(issues)).toContain('nodes.nodo_ia.onErrorStep');
      expect(issues[0].constraints[0]).toContain('nodo_fantasma');
    });

    it('deberia rechazar una ruta con catchErrors que no son cadenas', async () => {
      // 1. Arrange: `whitelist` no poda el interior de un objeto suelto, asi que
      //    si el constraint no lo mirase, el motor acabaria comparando numeros.
      const schema = buildNotiwebSchema();
      schema.nodes.nodo_ia.onErrorStep = {
        targetNode: 'nodo_destino',
        catchErrors: [42],
      } as unknown as PipelineSchema['nodes'][string]['onErrorStep'];

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert
      expect(fieldsOf(issues)).toContain('nodes.nodo_ia.onErrorStep');
    });

    it('deberia rechazar un onErrorStep que no es ninguna de las tres formas', async () => {
      // 1. Arrange
      const schema = buildNotiwebSchema();
      schema.nodes.nodo_ia.onErrorStep = 7 as unknown as string;

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert
      expect(fieldsOf(issues)).toContain('nodes.nodo_ia.onErrorStep');
    });

    it('deberia rechazar una clave de mapa distinta del nodeId del nodo', async () => {
      // 1. Arrange
      const schema = buildNotiwebSchema();
      schema.nodes.nodo_parser.nodeId = 'identificador_desincronizado';

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert
      expect(fieldsOf(issues)).toContain('nodes.nodo_parser.nodeId');
    });

    it('deberia rechazar un entrypoint que no existe en el mapa de nodos', async () => {
      // 1. Arrange
      const schema = buildNotiwebSchema();
      schema.entrypoint = 'nodo_fantasma';

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert
      expect(fieldsOf(issues)).toContain('entrypoint');
    });

    it('deberia rechazar un nextStep que apunta a un nodo inexistente', async () => {
      // 1. Arrange
      const schema = buildNotiwebSchema();
      schema.nodes.nodo_escudo.nextStep = 'nodo_inexistente';

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert
      expect(fieldsOf(issues)).toContain('nodes.nodo_escudo.nextStep');
    });

    it('deberia rechazar un onErrorStep que apunta a un nodo inexistente', async () => {
      // 1. Arrange
      const schema = buildNotiwebSchema();
      schema.nodes.nodo_ia.onErrorStep = 'nodo_inexistente';

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert
      expect(fieldsOf(issues)).toContain('nodes.nodo_ia.onErrorStep');
    });
  });

  describe('validacion de forma y tipos', () => {
    it('deberia rechazar un nodeType que no pertenece al enum permitido', async () => {
      // 1. Arrange
      const schema = buildNotiwebSchema();
      schema.nodes.nodo_ia.nodeType = 'NODO_INVENTADO' as NodeType;

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert
      expect(fieldsOf(issues)).toContain('nodes.nodo_ia.nodeType');
    });

    it('deberia rechazar un maxRetries que supera el limite permitido', async () => {
      // 1. Arrange
      const schema = buildNotiwebSchema();
      schema.nodes.nodo_ia.retryPolicy = { maxRetries: 6 };

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert: la ruta conserva el nodo y el campo anidado
      expect(fieldsOf(issues)).toContain(
        'nodes.nodo_ia.retryPolicy.maxRetries',
      );
    });

    it('deberia rechazar un outputNamespace que no es snake_case', async () => {
      // 1. Arrange
      const schema = buildNotiwebSchema();
      schema.nodes.nodo_parser.outputNamespace = 'ParsedEmail';

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert
      expect(fieldsOf(issues)).toContain('nodes.nodo_parser.outputNamespace');
    });

    it('deberia aceptar un esquema con executionPolicy declarada', async () => {
      // 1. Arrange: `forbidNonWhitelisted` esta activo, asi que un campo raiz no
      //    declarado en el DTO se rechaza en vez de ignorarse. Esta prueba fija
      //    que la politica SI esta declarada.
      const schema = {
        ...buildNotiwebSchema(),
        executionPolicy: { stopOnFirstSuccess: true },
      };

      // 2. Act
      const result = await service.validateSchema(schema);

      // 3. Assert
      expect(result.executionPolicy?.stopOnFirstSuccess).toBe(true);
    });

    it('deberia rechazar un stopOnFirstSuccess que no es booleano', async () => {
      // 1. Arrange
      const schema = {
        ...buildNotiwebSchema(),
        executionPolicy: { stopOnFirstSuccess: 'si' },
      };

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert: la ruta llega ANIDADA, que es lo que permite al asistente
      //    senalar el control exacto en vez de la raiz del esquema.
      expect(fieldsOf(issues)).toContain('executionPolicy.stopOnFirstSuccess');
    });

    it('deberia rechazar una version que no sigue el formato SemVer', async () => {
      // 1. Arrange
      const schema = buildNotiwebSchema();
      schema.version = 'v1';

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert
      expect(fieldsOf(issues)).toContain('version');
    });

    it('deberia rechazar una propiedad no declarada en el contrato', async () => {
      // 1. Arrange: un `nextStepp` mal escrito no puede colarse en silencio
      const schema = buildNotiwebSchema();
      (
        schema.nodes.trigger_imap as unknown as Record<string, unknown>
      ).nextStepp = 'nodo_parser';

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert
      expect(fieldsOf(issues)).toContain('nodes.trigger_imap.nextStepp');
    });

    it('deberia rechazar un nodo que no es un objeto de configuracion', async () => {
      // 1. Arrange
      const schema = buildNotiwebSchema();
      (schema.nodes as unknown as Record<string, unknown>).nodo_roto =
        'no soy un nodo';

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert
      expect(fieldsOf(issues)).toContain('nodes.nodo_roto');
    });

    it('deberia rechazar un payload que no es un objeto JSON', async () => {
      // 2. Act
      const issues = await captureIssues(service, [
        'no',
        'soy',
        'un',
        'esquema',
      ]);

      // 3. Assert
      expect(fieldsOf(issues)).toEqual(['(root)']);
    });
  });

  describe('regla 7: namespaces requeridos aguas arriba', () => {
    /**
     * Servicio con una factoria sembrada de estrategias que SI declaran
     * dependencias.
     *
     * Se registran dobles y no las estrategias reales para que estas pruebas
     * examinen la REGLA y no la configuracion de un nodo concreto: si manana el
     * parser cambiara su `sourceNamespace` por defecto, estas pruebas no deben
     * ponerse rojas por ello.
     */
    const buildServiceWith = (
      requirements: Partial<Record<NodeType, readonly string[]>>,
    ): PipelineValidatorService => {
      const factory = new NodeStrategyFactory();
      jest.spyOn(factory['logger'], 'log').mockImplementation(() => undefined);

      for (const [nodeType, namespaces] of Object.entries(requirements)) {
        factory.registerStrategy({
          nodeType: nodeType as NodeType,
          execute: jest.fn(),
          getRequiredNamespaces: () => namespaces,
        });
      }

      return new PipelineValidatorService(factory);
    };

    it('deberia rechazar un nodo que necesita un namespace que nadie escribe antes', async () => {
      // 1. Arrange: el parser va PRIMERO, asi que nadie ha escrito `raw_email`.
      const schema = buildNotiwebSchema();
      const service = buildServiceWith({
        [NodeType.PARSER_PRE_IA]: ['raw_email'],
      });
      schema.entrypoint = 'nodo_parser';

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert: el flujo ni siquiera llega a persistirse, que es la mejora
      //    sobre la guarda del motor: alli se descubre con la ejecucion creada.
      expect(fieldsOf(issues)).toContain('nodes.nodo_parser.params');
      expect(issues[0].constraints[0]).toContain('raw_email');
    });

    it('deberia aceptar el flujo cuando un paso anterior escribe el namespace', async () => {
      // 1. Arrange: orden correcto, el trigger escribe `raw_email` antes.
      const service = buildServiceWith({
        [NodeType.PARSER_PRE_IA]: ['raw_email'],
      });

      // 2. Act
      const result = await service.validateSchema(buildNotiwebSchema());

      // 3. Assert
      expect(result.entrypoint).toBe('trigger_imap');
    });

    it('no deberia exigir nada a un tipo de nodo sin estrategia registrada', async () => {
      // 1. Arrange: que el nodo no sea ejecutable es otro problema, y lo reporta
      //    el motor con ERR_STRATEGY_NOT_FOUND. Convertirlo aqui en un fallo de
      //    dependencias mandaria al operador a reordenar un flujo bien ordenado.
      const service = buildServiceWith({});

      // 2. Act
      const result = await service.validateSchema(buildNotiwebSchema());

      // 3. Assert
      expect(result.nodes.nodo_parser.nodeId).toBe('nodo_parser');
    });

    it('no deberia juzgar un nodo alcanzable solo por onErrorStep', async () => {
      // 1. Arrange: un nodo colgado unicamente de una ruta de error tiene un
      //    conjunto de predecesores distinto segun por donde se entre, asi que
      //    afirmar sobre el al guardar seria adivinar. Lo cubre el motor.
      const schema = buildNotiwebSchema();
      const service = buildServiceWith({
        [NodeType.DESTINO_HTTP]: ['namespace_inventado'],
      });
      const terminal = Object.values(schema.nodes).find(
        (node) => node.nodeType === NodeType.DESTINO_HTTP,
      );

      if (terminal !== undefined) {
        // Se descuelga del camino activo: solo se llega por la ruta de error.
        for (const node of Object.values(schema.nodes)) {
          if (node.nextStep === terminal.nodeId) {
            node.nextStep = null;
            node.onErrorStep = terminal.nodeId;
          }
        }
      }

      // 2. Act
      const result = await service.validateSchema(schema);

      // 3. Assert
      expect(result.entrypoint).toBe('trigger_imap');
    });

    it('no deberia exigir el namespace reservado del disparador', async () => {
      // 1. Arrange: `trigger` lo siembra el motor al crear la ejecucion, y
      //    ningun nodo lo declara como salida.
      const service = buildServiceWith({
        [NodeType.PARSER_PRE_IA]: ['trigger'],
      });

      // 2. Act
      const result = await service.validateSchema(buildNotiwebSchema());

      // 3. Assert: exigir que algun nodo lo produzca lo haria irresoluble por
      //    construccion.
      expect(result.entrypoint).toBe('trigger_imap');
    });
  });
});
