import { BadRequestException } from '@nestjs/common';

import { PipelineSchemaDto } from '@core/fsm/dto/pipeline-schema.dto';
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
  entrypoint: 'nodo_trigger',
  nodes: {
    nodo_trigger: {
      nodeId: 'nodo_trigger',
      nodeType: NodeType.TRIGGER_IMAP,
      outputNamespace: 'nodo_trigger',
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
      outputNamespace: 'ia_result',
      nextStep: 'nodo_escudo',
      onErrorStep: null,
      retryPolicy: { maxRetries: 2 },
      params: { promptKey: 'extract_news' },
    },
    nodo_escudo: {
      nodeId: 'nodo_escudo',
      nodeType: NodeType.ESCUDO_POST_IA,
      outputNamespace: 'nodo_sanitizado',
      nextStep: 'nodo_mapeador',
      onErrorStep: null,
      params: { schemaId: 'noticia_v1' },
    },
    nodo_mapeador: {
      nodeId: 'nodo_mapeador',
      nodeType: NodeType.MAPEADOR_PLANTILLA,
      outputNamespace: 'plantilla_render',
      nextStep: 'nodo_destino',
      onErrorStep: null,
      params: { templateId: 'tpl-1' },
    },
    nodo_destino: {
      nodeId: 'nodo_destino',
      nodeType: NodeType.DESTINO_HTTP,
      outputNamespace: 'destino_http',
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
    service = new PipelineValidatorService();
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
      expect(result.entrypoint).toBe('nodo_trigger');
    });

    it('deberia aceptar un nodo huerfano inalcanzable desde el entrypoint', async () => {
      // 1. Arrange: rama en construccion que nadie referencia todavia
      const schema = buildNotiwebSchema();
      schema.nodes.nodo_huerfano = {
        nodeId: 'nodo_huerfano',
        nodeType: NodeType.EXTRACTOR_WEB,
        outputNamespace: 'rama_futura',
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
        schema.nodes.nodo_trigger as unknown as Record<string, unknown>
      ).nextStepp = 'nodo_parser';

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert
      expect(fieldsOf(issues)).toContain('nodes.nodo_trigger.nextStepp');
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
});
