import { BadRequestException } from '@nestjs/common';

import { PipelineSchemaDto } from '@core/fsm/dto/pipeline-schema.dto';
import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import { PipelineValidatorService } from '@core/fsm/services/pipeline-validator.service';
import { ERR_MISSING_UPSTREAM_CONTEXT } from '@core/fsm/types/node-strategy.types';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { WebScraperStrategy } from '@modules/nodes/strategies/web-scraper.strategy';

import type { WebScraperRunner } from '@modules/nodes/services/web-scraper.runner';

import type { PipelineSchema } from '@core/fsm/types/pipeline-schema.types';
import type { ValidateSchemaOptions } from '@core/fsm/services/pipeline-validator.service';
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
      // `params: {}` y no el `schemaId` de antes: desde que `ESCUDO_POST_IA`
      // tiene estrategia, su `paramsSchema` corre con `forbidNonWhitelisted` y
      // esa clave seria un 400. El fixture describe un esquema valido, asi que
      // no puede declarar algo que el modulo real rechazaria.
      params: {},
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
      nodeType: NodeType.DESTINO_DRUPAL,
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
  options?: ValidateSchemaOptions,
): Promise<SchemaIssue[]> => {
  try {
    await service.validateSchema(schema, options);
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
    // Factoria VACIA a proposito: sin estrategias registradas ningun nodo
    // declara dependencias, y como los `params` de `buildNotiwebSchema` no
    // interpolan nada, el barrido por marcas tampoco encuentra ninguna: la regla
    // 7 no interviene por ninguno de sus dos canales. Estas pruebas examinan las
    // otras seis reglas, y sembrar estrategias aqui las acoplaria a la
    // configuracion de unos nodos que no vienen al caso. La regla 7 tiene su
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

      // 3. Assert: se busca el issue del CICLO en vez de asumir que es el
      // primero. El nodo que cierra el lazo es ademas un destino, asi que la
      // regla 11 emite el suyo sobre el mismo campo y ambas son correctas.
      expect(fieldsOf(issues)).toContain('nodes.nodo_destino.nextStep');
      expect(
        issues.some((issue) =>
          issue.constraints.some((constraint) =>
            constraint.includes('ciclo infinito'),
          ),
        ),
      ).toBe(true);
    });

    it('deberia rechazar un pipeline cuyo entry point no sea TRIGGER', async () => {
      // 1. Arrange: el mapeador abre el flujo. Nadie escribe `trigger`, asi que
      //    en ejecucion el motor arrancaria sobre un contexto vacio.
      const schema = buildNotiwebSchema();
      schema.entrypoint = 'nodo_mapeador';
      schema.nodes.nodo_mapeador.nextStep = null;

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert: el 400 llega desde el servicio, no solo desde la funcion pura.
      const issue = issues.find(
        (candidate) => candidate.field === 'nodes.nodo_mapeador.nodeType',
      );

      expect(issue?.constraints).toEqual([
        'El nodo inicial (Entry Point) debe ser un disparador de categoria TRIGGER',
      ]);
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
      // Los tipos que esta prueba no siembra hacen que la factoria registre un
      // ERROR por consulta. Es ruido esperado y taparia un fallo real.
      jest
        .spyOn(factory['logger'], 'error')
        .mockImplementation(() => undefined);

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
      const issue = issues.find(
        (candidate) => candidate.field === 'nodes.nodo_parser.params',
      );

      expect(issue).toBeDefined();
      expect(issue?.constraints[0]).toContain('raw_email');
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
      //    Sus `params` no interpolan nada, asi que el segundo canal tampoco
      //    tiene nada que decir.
      const service = buildServiceWith({});

      // 2. Act
      const result = await service.validateSchema(buildNotiwebSchema());

      // 3. Assert
      expect(result.nodes.nodo_parser.nodeId).toBe('nodo_parser');
    });

    it('deberia detectar por interpolacion la dependencia de un nodo que no la declara', async () => {
      // 1. Arrange: el mapeador NO implementa `getRequiredNamespaces` —sus
      //    variables viven en `plantillas_html` y derivarlas exigiria una
      //    consulta—, y su `params` interpola un namespace que escribe un nodo
      //    POSTERIOR. Sin el barrido por marcas esto se guardaba sin protestar.
      const schema = buildNotiwebSchema();
      const service = buildServiceWith({});
      schema.nodes.nodo_mapeador.params = {
        templateId: 'tpl-1',
        asunto: '{{http_result.status}}',
      };

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert
      expect(fieldsOf(issues)).toContain('nodes.nodo_mapeador.params');
      expect(issues[0].constraints[0]).toContain('http_result');
    });

    it('deberia encontrar la marca en cualquier clave anidada de params', async () => {
      // 1. Arrange: el barrido no privilegia ningun campo. Un `targetUrl` lo
      //    sabe leer la estrategia del extractor, pero una cabecera dentro de un
      //    objeto anidado no la mira nadie mas.
      const schema = buildNotiwebSchema();
      const service = buildServiceWith({});
      schema.nodes.nodo_destino.params = {
        url: 'https://drupal.unuware.com/jsonapi/node/article',
        headers: { 'X-Origen': '{{namespace_inventado.campo}}' },
      };

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert
      expect(fieldsOf(issues)).toContain('nodes.nodo_destino.params');
      expect(issues[0].constraints[0]).toContain('namespace_inventado');
    });

    it('deberia aceptar una interpolacion que un paso anterior si escribe', async () => {
      // 1. Arrange: el mapeador lee del escudo, que va justo antes.
      const schema = buildNotiwebSchema();
      const service = buildServiceWith({});
      schema.nodes.nodo_mapeador.params = {
        templateId: 'tpl-1',
        cuerpo: '{{validated_drupal_json.title}}',
      };

      // 2. Act
      const result = await service.validateSchema(schema);

      // 3. Assert
      expect(result.entrypoint).toBe('trigger_imap');
    });

    it('no deberia duplicar un namespace que declaran las dos fuentes a la vez', async () => {
      // 1. Arrange: el extractor web deriva su dependencia justamente de
      //    `targetUrl`, asi que lo declarado y lo barrido coinciden. Sin
      //    deduplicar, el mensaje nombraria `parsed_email` dos veces.
      const schema = buildNotiwebSchema();
      const service = buildServiceWith({
        [NodeType.EXTRACTOR_WEB]: ['parsed_email'],
      });
      schema.entrypoint = 'nodo_extractor';
      schema.nodes.nodo_extractor.params = {
        targetUrl: '{{parsed_email.extracted_urls[0]}}',
      };

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert
      const [constraint] = issues.find(
        (candidate) => candidate.field === 'nodes.nodo_extractor.params',
      )!.constraints;
      expect(constraint).toContain('parsed_email');
      expect(constraint.match(/parsed_email/g)).toHaveLength(1);
    });

    it('no deberia juzgar un nodo alcanzable solo por onErrorStep', async () => {
      // 1. Arrange: un nodo colgado unicamente de una ruta de error tiene un
      //    conjunto de predecesores distinto segun por donde se entre, asi que
      //    afirmar sobre el al guardar seria adivinar. Lo cubre el motor.
      const schema = buildNotiwebSchema();
      const service = buildServiceWith({
        [NodeType.DESTINO_DRUPAL]: ['namespace_inventado'],
      });
      const terminal = Object.values(schema.nodes).find(
        (node) => node.nodeType === NodeType.DESTINO_DRUPAL,
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

  describe('namespaces que citan los prompts guardados', () => {
    const PROMPT_ID = '9f1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
    const PROMPT_CODE = 'NOTIWEB_DEFAULT';

    /** El texto real del prompt sembrado: cita `scraped_web`. */
    const NOTIWEB_TEXT =
      'Redacta la noticia.\nDirectiva: {{parsed_email.clean_body}}\nArticulo: {{scraped_web.full_article_content}}';

    /**
     * Servicio con una estrategia de IA que declara sus referencias a prompt y
     * un puerto doblado que devuelve el texto.
     *
     * El doble del puerto es lo que permite probar la regla SIN base de datos:
     * la pregunta de estas pruebas es si el validador cruza el texto del prompt
     * con la topologia, no si TypeORM sabe leer una fila.
     */
    const buildServiceWithPrompt = (
      texts: ReadonlyMap<string, string>,
    ): {
      readonly service: PipelineValidatorService;
      readonly resolvePromptTexts: jest.Mock;
    } => {
      const factory = new NodeStrategyFactory();
      jest.spyOn(factory['logger'], 'log').mockImplementation(() => undefined);
      jest
        .spyOn(factory['logger'], 'error')
        .mockImplementation(() => undefined);

      factory.registerStrategy({
        nodeType: NodeType.PROCESADOR_IA,
        execute: jest.fn(),
        getPromptReferences: (params) => {
          const { templatePromptId, promptCode } = params;

          if (typeof templatePromptId === 'string') {
            return [{ kind: 'id', value: templatePromptId }];
          }

          return typeof promptCode === 'string'
            ? [{ kind: 'code', value: promptCode }]
            : [];
        },
      });

      const resolvePromptTexts = jest.fn().mockResolvedValue(texts);

      return {
        service: new PipelineValidatorService(factory, { resolvePromptTexts }),
        resolvePromptTexts,
      };
    };

    /** Esquema sin extractor: trigger -> parser -> IA. */
    const buildSchemaWithoutScraper = (
      params: Record<string, unknown>,
    ): PipelineSchema => {
      const schema = buildNotiwebSchema();

      schema.nodes.nodo_parser.nextStep = 'nodo_ia';
      schema.nodes.nodo_ia.params = params;
      delete schema.nodes.nodo_extractor;

      return schema;
    };

    it('deberia rechazar un prompt por codigo que cita un namespace ausente', async () => {
      // 1. Arrange: es el caso real de `NOTIWEB_DEFAULT`. Antes de esto el flujo
      //    se guardaba y se activaba sin queja, y reventaba en ejecucion con
      //    ERR_LLM_INTERPOLATION ya PAUSADO.
      const { service } = buildServiceWithPrompt(
        new Map([[`code:${PROMPT_CODE}`, NOTIWEB_TEXT]]),
      );
      const schema = buildSchemaWithoutScraper({ promptCode: PROMPT_CODE });

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert
      const issue = issues.find(
        (candidate) => candidate.field === 'nodes.nodo_ia.params',
      );

      expect(issue?.code).toBe(ERR_MISSING_UPSTREAM_CONTEXT);
      expect(issue?.constraints[0]).toContain('scraped_web');
    });

    it('deberia nombrar el prompt del que sale la dependencia', async () => {
      // 1. Arrange: sin esto el operador leeria "necesitas scraped_web", miraria
      //    los params del nodo y no encontraria ningun marcador que lo explique.
      const { service } = buildServiceWithPrompt(
        new Map([[`code:${PROMPT_CODE}`, NOTIWEB_TEXT]]),
      );
      const schema = buildSchemaWithoutScraper({ promptCode: PROMPT_CODE });

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert
      const issue = issues.find(
        (candidate) => candidate.field === 'nodes.nodo_ia.params',
      );

      expect(issue?.constraints[0]).toContain(PROMPT_CODE);
    });

    it('deberia aceptar el mismo flujo con el extractor por delante', async () => {
      // 1. Arrange: la comprobacion no es un bloqueo indiscriminado
      const { service } = buildServiceWithPrompt(
        new Map([[`code:${PROMPT_CODE}`, NOTIWEB_TEXT]]),
      );
      const schema = buildNotiwebSchema();
      schema.nodes.nodo_ia.params = { promptCode: PROMPT_CODE };

      // 2. Act
      const result = await service.validateSchema(schema);

      // 3. Assert
      expect(result.entrypoint).toBe('trigger_imap');
    });

    it('deberia rechazar igual cuando el prompt se cita por id', async () => {
      // 1. Arrange
      const { service } = buildServiceWithPrompt(
        new Map([[`id:${PROMPT_ID}`, NOTIWEB_TEXT]]),
      );
      const schema = buildSchemaWithoutScraper({ templatePromptId: PROMPT_ID });

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert
      const issue = issues.find(
        (candidate) => candidate.field === 'nodes.nodo_ia.params',
      );

      expect(issue?.constraints[0]).toContain('scraped_web');
    });

    it('deberia aceptar un prompt que solo cita lo que el flujo si produce', async () => {
      // 1. Arrange: el equivalente de `LICITACION_APERTURA_DEFAULT`, que solo pide
      //    `parsed_email` — y el parser va por delante.
      const { service } = buildServiceWithPrompt(
        new Map([
          [
            `code:LICITACION_APERTURA_DEFAULT`,
            'Extrae de {{parsed_email.clean_body}}',
          ],
        ]),
      );
      const schema = buildSchemaWithoutScraper({
        promptCode: 'LICITACION_APERTURA_DEFAULT',
      });

      // 2. Act
      const result = await service.validateSchema(schema);

      // 3. Assert
      expect(result.entrypoint).toBe('trigger_imap');
    });

    it('no deberia inventar un fallo de dependencias si el prompt no existe', async () => {
      // 1. Arrange: mapa vacio. De la plantilla que falta se queja la ejecucion
      //    con ERR_LLM_PROMPT_UNRESOLVED; tratarla aqui como namespace ausente
      //    mandaria a reordenar un flujo cuyo orden esta bien.
      const { service } = buildServiceWithPrompt(new Map());
      const schema = buildSchemaWithoutScraper({ promptCode: PROMPT_CODE });

      // 2. Act
      const result = await service.validateSchema(schema);

      // 3. Assert
      expect(result.entrypoint).toBe('trigger_imap');
    });

    it('deberia resolver todas las referencias en UNA sola llamada', async () => {
      // 1. Arrange: dos nodos de IA citando prompts. Validar un flujo no puede
      //    costar una consulta por nodo.
      const { service, resolvePromptTexts } = buildServiceWithPrompt(
        new Map([[`code:${PROMPT_CODE}`, 'Usa {{parsed_email.clean_body}}']]),
      );
      const schema = buildNotiwebSchema();
      schema.nodes.nodo_ia.params = { promptCode: PROMPT_CODE };

      // 2. Act
      await service.validateSchema(schema);

      // 3. Assert
      expect(resolvePromptTexts).toHaveBeenCalledTimes(1);
    });

    it('no deberia consultar nada si ningun nodo cita un prompt guardado', async () => {
      // 1. Arrange: el caso normal no paga ninguna consulta
      const { service, resolvePromptTexts } = buildServiceWithPrompt(new Map());
      const schema = buildNotiwebSchema();

      // 2. Act
      await service.validateSchema(schema);

      // 3. Assert
      expect(resolvePromptTexts).not.toHaveBeenCalled();
    });

    it('deberia comportarse como antes sin puerto inyectado', async () => {
      // 1. Arrange: el puerto es opcional, y un contexto que no lo provea debe
      //    seguir validando. Es lo que protege a las pruebas de los demas bloques.
      const factory = new NodeStrategyFactory();
      jest
        .spyOn(factory['logger'], 'error')
        .mockImplementation(() => undefined);
      const service = new PipelineValidatorService(factory);
      const schema = buildSchemaWithoutScraper({ promptCode: PROMPT_CODE });

      // 2. Act
      const result = await service.validateSchema(schema);

      // 3. Assert
      expect(result.entrypoint).toBe('trigger_imap');
    });
  });

  describe('satelite OCR fuera del camino activo', () => {
    /** Grafo con `ocr_ia` alcanzable SOLO por la ruta de error del parser. */
    const buildOcrSchema = (): Record<string, unknown> => ({
      flowId: 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      name: 'Rescate por OCR',
      version: '1.0.0',
      entrypoint: 'trigger_imap',
      nodes: {
        trigger_imap: {
          nodeId: 'trigger_imap',
          nodeType: NodeType.TRIGGER_IMAP,
          outputNamespace: 'raw_email',
          nextStep: 'parser_pre_ia',
          onErrorStep: null,
          params: {},
        },
        parser_pre_ia: {
          nodeId: 'parser_pre_ia',
          nodeType: NodeType.PARSER_PRE_IA,
          outputNamespace: 'parsed_email',
          nextStep: 'procesador_ia',
          onErrorStep: {
            targetNode: 'ocr_ia',
            catchErrors: ['ERR_PARSER_UNEXTRACTABLE_MEDIA'],
          },
          params: { failOnUnextractableMedia: true },
        },
        ocr_ia: {
          nodeId: 'ocr_ia',
          nodeType: NodeType.PROCESADOR_OCR,
          outputNamespace: 'ocr_result',
          nextStep: 'procesador_ia',
          onErrorStep: null,
          params: {},
        },
        procesador_ia: {
          nodeId: 'procesador_ia',
          nodeType: NodeType.PROCESADOR_IA,
          outputNamespace: 'llm_response',
          nextStep: null,
          onErrorStep: null,
          params: { inlinePrompt: 'Redacta.' },
        },
      },
    });

    it('deberia ACEPTAR el grafo completo del rescate', async () => {
      // 1. Arrange 📐: cubre de una vez las cuatro reglas que tocan al satelite
      //    —3 (destinos existentes), 4 (namespace en la lista cerrada), 5 (sin
      //    duplicados) y 10 (el parser SI puede emitir el codigo que la ruta
      //    atrapa, porque lleva `failOnUnextractableMedia`)—.
      const schema = buildOcrSchema();

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(service.validateSchema(schema)).resolves.toBeDefined();
    });

    it('deberia RECHAZAR que el satelite comparta namespace con el parser', async () => {
      // 1. Arrange 📐: es la razon de que `PROCESADOR_OCR` tenga `ocr_result`
      //    propio. Sin el, el satelite chocaria con algun nodo del camino y la
      //    rama de contingencia no podria auto-aprovisionarse.
      const schema = buildOcrSchema();
      const nodes = schema.nodes as Record<string, { outputNamespace: string }>;

      nodes.ocr_ia.outputNamespace = 'parsed_email';

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(service.validateSchema(schema)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('deberia RECHAZAR un satelite que apunta fuera del mapa', async () => {
      // 1. Arrange 📐: regla 3 sobre `nextStep`. Un satelite que reincorpora a
      //    ningun sitio dejaria el flujo muerto justo despues del rescate.
      const schema = buildOcrSchema();
      const nodes = schema.nodes as Record<string, { nextStep: string | null }>;

      nodes.ocr_ia.nextStep = 'nodo_que_no_existe';

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(service.validateSchema(schema)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('validacion de params contra el DTO de la estrategia', () => {
    /**
     * Servicio con la estrategia REAL del extractor registrada.
     *
     * Aqui si se usa la real y no un doble, al reves que en el bloque anterior:
     * lo que se examina es precisamente que el DTO del nodo corra al guardar, y
     * con un doble la prueba solo aseveraria sobre el doble.
     */
    const buildServiceWithScraper = (): PipelineValidatorService => {
      const factory = new NodeStrategyFactory();
      jest.spyOn(factory['logger'], 'log').mockImplementation(() => undefined);
      // Tambien el `error`: los otros seis nodos del esquema no tienen
      // estrategia aqui, y la factoria registra un ERROR por cada consulta. Es
      // ruido esperado que taparia un fallo real en la salida de Jest.
      jest
        .spyOn(factory['logger'], 'error')
        .mockImplementation(() => undefined);
      factory.registerStrategy(
        new WebScraperStrategy({} as unknown as WebScraperRunner),
      );
      // Doble del parser, y hace falta: el extractor declara
      // `requiredUpstreamFieldTypes` y la regla 8 exige que alguien publique un
      // campo de tipo URL antes que el. Sin este doble, todas las pruebas de
      // este bloque fallarian por topologia en vez de por lo que examinan, que
      // es la validacion de `params` contra el DTO de la estrategia.
      factory.registerStrategy({
        nodeType: NodeType.PARSER_PRE_IA,
        execute: jest.fn(),
        outputFields: [{ name: 'extracted_urls', type: 'url[]' }],
      });

      return new PipelineValidatorService(factory);
    };

    /** Esquema con el extractor ya bien configurado, listo para estropearlo. */
    const buildScraperSchema = (
      params: Record<string, unknown>,
    ): PipelineSchema => {
      const schema = buildNotiwebSchema();

      schema.nodes.nodo_extractor.params = params;

      return schema;
    };

    it('deberia rechazar al GUARDAR un targetUrl literal', async () => {
      // 1. Arrange
      const service = buildServiceWithScraper();
      const schema = buildScraperSchema({
        targetUrl: 'https://portal.es/noticias',
      });

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert: esta es la mejora. Antes `params` solo se comprobaba como
      //    "es un objeto", el esquema se persistia y el fallo aparecia en la
      //    primera ejecucion con el flujo ya PAUSADO.
      expect(fieldsOf(issues)).toContain(
        'nodes.nodo_extractor.params.targetUrl',
      );
      expect(issues[0].constraints[0]).toContain('variable interpolada');
    });

    it('deberia rechazar una clave que el DTO del nodo no declara', async () => {
      // 1. Arrange
      const service = buildServiceWithScraper();
      const schema = buildScraperSchema({
        targetUrl: '{{parsed_email.extracted_urls[0]}}',
        selecctor: 'article',
      });

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert: `forbidNonWhitelisted` evita que una clave mal escrita se
      //    descarte en silencio y el nodo corra con una configuracion que nadie
      //    pidio.
      expect(fieldsOf(issues)).toContain(
        'nodes.nodo_extractor.params.selecctor',
      );
    });

    it('deberia aceptar un extractor bien configurado', async () => {
      // 1. Arrange
      const service = buildServiceWithScraper();
      const schema = buildScraperSchema({
        targetUrl: '{{parsed_email.extracted_urls[0]}}',
        timeoutMs: 30_000,
      });

      // 2. Act
      const result = await service.validateSchema(schema);

      // 3. Assert
      expect(result.nodes.nodo_extractor.params.timeoutMs).toBe(30_000);
    });

    it('no deberia tocar los params de un nodo sin estrategia registrada', async () => {
      // 1. Arrange: los otros seis nodos del esquema no tienen estrategia en
      //    esta factoria, y sus `params` (`{ promptKey: ... }`, `{ tplId: ... }`)
      //    no seguirian ningun DTO. Deben pasar igual.
      const service = buildServiceWithScraper();
      const schema = buildScraperSchema({
        targetUrl: '{{parsed_email.extracted_urls[0]}}',
      });

      // 2. Act
      const result = await service.validateSchema(schema);

      // 3. Assert
      expect(result.nodes.nodo_ia.params.promptKey).toBe('extract_news');
    });
  });

  describe('plantillas de flujo: guardar a medias vs activar', () => {
    /**
     * Servicio con el extractor REAL y un parser doblado que publica enlaces.
     *
     * El parser va doblado y no real porque lo que se examina es la asimetria
     * entre guardar y activar, no su configuracion; lo unico que hace falta de
     * el es que satisfaga la regla 8.
     */
    const buildService = (): PipelineValidatorService => {
      const factory = new NodeStrategyFactory();
      jest.spyOn(factory['logger'], 'log').mockImplementation(() => undefined);
      jest
        .spyOn(factory['logger'], 'error')
        .mockImplementation(() => undefined);
      factory.registerStrategy(
        new WebScraperStrategy({} as unknown as WebScraperRunner),
      );
      factory.registerStrategy({
        nodeType: NodeType.PARSER_PRE_IA,
        execute: jest.fn(),
        outputFields: [{ name: 'extracted_urls', type: 'url[]' }],
      });

      return new PipelineValidatorService(factory);
    };

    /** Esquema con el extractor SIN operativa, como lo trae una plantilla. */
    const buildTemplateSchema = (): PipelineSchema => {
      const schema = buildNotiwebSchema();

      schema.nodes.nodo_extractor.params = {};

      return schema;
    };

    it('deberia GUARDAR una plantilla con el extractor sin targetUrl', async () => {
      // 1. Arrange: es el caso que fallaba con tres constraints a la vez
      //    —incluido "debe ser una cadena", que delata que el campo ni siquiera
      //    estaba—. Una plantilla declara topologia; la operativa se elige al
      //    instanciar el flujo en el asistente.
      const service = buildService();

      // 2. Act
      const result = await service.validateSchema(buildTemplateSchema());

      // 3. Assert
      expect(result.nodes.nodo_extractor.params).toEqual({});
    });

    it('NO deberia dejar ACTIVAR ese mismo esquema', async () => {
      // 1. Arrange
      const service = buildService();

      // 2. Act
      const issues = await captureIssues(service, buildTemplateSchema(), {
        requireRunnableParams: true,
      });

      // 3. Assert: la red esta en `assertActivatable`. Guardar es un borrador;
      //    activar es ponerlo a disparar.
      expect(fieldsOf(issues)).toContain('nodes.nodo_extractor.params');
      expect(issues[0].code).toBe('ERR_INCOMPLETE_NODE_PARAMS');
      expect(issues[0].constraints[0]).toContain('targetUrl');
    });

    it('deberia dejar activar el esquema una vez elegido el origen', async () => {
      // 1. Arrange
      const service = buildService();
      const schema = buildTemplateSchema();
      schema.nodes.nodo_extractor.params = {
        targetUrl: '{{parsed_email.extracted_urls[0]}}',
      };

      // 2. Act
      const result = await service.validateSchema(schema, {
        requireRunnableParams: true,
      });

      // 3. Assert
      expect(result.entrypoint).toBe('trigger_imap');
    });

    it('deberia rechazar TRIGGER_IMAP -> EXTRACTOR_WEB por la regla 8', async () => {
      // 1. Arrange: sin parser por delante no hay de donde sacar un enlace, y
      //    eso es un problema de TOPOLOGIA aunque el nodo estuviera configurado.
      const service = buildService();
      const schema = buildTemplateSchema();
      schema.nodes.trigger_imap.nextStep = 'nodo_extractor';

      // 2. Act
      const issues = await captureIssues(service, schema);

      // 3. Assert: el mensaje describe el flujo, no el campo. Antes el operador
      //    recibia "targetUrl debe ser una cadena", que no dice nada del orden.
      expect(fieldsOf(issues)).toContain('nodes.nodo_extractor.params');
      expect(issues[0].code).toBe('ERR_MISSING_UPSTREAM_FIELD_TYPE');
      expect(issues[0].constraints[0]).toContain('Ningun paso anterior');
    });

    it('deberia ACEPTAR ese mismo flujo si el extractor es omitible', async () => {
      // 1. Arrange 📐: la contingencia OCR. No hay de donde sacar un enlace y el
      //    nodo lo DECLARA con `skipIfEmpty`, de modo que la exigencia de la
      //    regla 8 deja de aplicarle: es una topologia legitima, no un olvido.
      const service = buildService();
      const schema = buildTemplateSchema();
      schema.nodes.trigger_imap.nextStep = 'nodo_extractor';
      schema.nodes.nodo_extractor.params = { skipIfEmpty: true };

      // 2. Act ⚙️
      const result = await service.validateSchema(schema, {
        requireRunnableParams: true,
      });

      // 3. Assert 🎯: guarda Y activa. El nodo publicara su payload neutro.
      expect(result.nodes.nodo_extractor.params).toEqual({ skipIfEmpty: true });
    });
  });
});
