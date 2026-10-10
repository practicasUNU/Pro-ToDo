import { ConfigService } from '@nestjs/config';

import { FsmConfig } from '@core/config/fsm.config';

import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import { FsmEngineService } from '@core/fsm/services/fsm-engine.service';
import { ExecutionState } from '@core/fsm/types/fsm.enums';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { ERR_PARSER_UNEXTRACTABLE_MEDIA } from '@modules/nodes/strategies/parser-email.strategy';

import type { HybridLoggerService } from '@modules/logs/services/hybrid-logger.service';
import type { PipelineSchemaDto } from '@core/fsm/dto/pipeline-schema.dto';
import type { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import type { INodeStrategy } from '@core/fsm/types/node-strategy.types';
import type { Repository } from 'typeorm';

const EXECUTION_ID = 'd4c3b2a1-9f8e-4d7c-8b6a-5e4f3d2c1b0a';
const FLOW_ID = 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

/** Identificador del satelite que el editor de plantillas provisiona. */
const OCR_NODE_ID = 'ocr_ia';

/** Transcripcion por encima del umbral de "texto util" del motor (50). */
const TRANSCRIPTION =
  '[TRANSCRIPCIÓN MOCK OCR]: Texto recuperado de imagen adjunta.';

const buildExecution = (): FsmExecution => ({
  executionId: EXECUTION_ID,
  flowId: FLOW_ID,
  currentState: ExecutionState.INACTIVO,
  activeCursor: null,
  contextPayload: {},
  retryState: {},
  logFilePath: null,
  failureReason: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const buildRepository = (
  execution: FsmExecution,
): { repo: Repository<FsmExecution>; update: jest.Mock } => {
  const findOne = jest.fn().mockResolvedValue(execution);
  const update = jest.fn().mockResolvedValue({ affected: 1 });

  return {
    repo: { findOne, update } as unknown as Repository<FsmExecution>,
    update,
  };
};

const buildStrategy = (
  nodeType: NodeType,
  execute: jest.Mock,
): INodeStrategy => ({ nodeType, execute });

/**
 * Grafo con el satelite OCR REINCORPORANDO el flujo.
 *
 * `ocr_ia` no esta en el camino activo —a el solo se llega por la ruta de error
 * del parser— pero su `nextStep` apunta al mismo sitio que el del parser, de
 * modo que el rescate devuelve el flujo a su curso en vez de terminarlo. Es la
 * diferencia con el satelite de alerta, que es terminal.
 */
const buildSchemaWithOcr = (): PipelineSchemaDto => ({
  flowId: FLOW_ID,
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
        targetNode: OCR_NODE_ID,
        catchErrors: [ERR_PARSER_UNEXTRACTABLE_MEDIA],
      },
      params: { failOnUnextractableMedia: true },
    },
    [OCR_NODE_ID]: {
      nodeId: OCR_NODE_ID,
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
      params: {},
    },
  },
});

/** Correo de solo imagen: el binario que el rescate necesita y luego sobra. */
const RAW_EMAIL_WITH_SCAN = {
  message_id: '<uno@unuware.com>',
  subject: 'Nota de prensa',
  attachments: [
    {
      filename: 'escaneo.png',
      contentType: 'image/png',
      contentBase64: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=',
    },
  ],
};

describe('Satelite OCR · desvio, reincorporacion y purga binaria', () => {
  const hybridLogger = {
    logCatastrophicFailure: jest.fn().mockReturnValue('logs/fsm.log'),
    logNodeExecution: jest.fn().mockResolvedValue(undefined),
  };

  let factory: NodeStrategyFactory;

  beforeEach(() => {
    jest.clearAllMocks();
    factory = new NodeStrategyFactory();
    jest.spyOn(factory['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(factory['logger'], 'log').mockImplementation(() => undefined);
  });

  const buildEngine = (repo: Repository<FsmExecution>): FsmEngineService => {
    const configService = new ConfigService({});
    const engine = new FsmEngineService(
      repo,
      factory,
      configService,
      hybridLogger as unknown as HybridLoggerService,
      new FsmConfig(configService),
    );

    jest.spyOn(engine['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(engine['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(engine['logger'], 'error').mockImplementation(() => undefined);

    return engine;
  };

  /**
   * Registra las cuatro estrategias del grafo.
   *
   * El parser falla SIEMPRE con el codigo del rescate; es el disparo de la ruta.
   */
  const registerStrategies = (): {
    ocr: jest.Mock;
    llm: jest.Mock;
    parser: jest.Mock;
  } => {
    const ocr = jest.fn().mockResolvedValue({
      success: true,
      data: {
        clean_body: TRANSCRIPTION,
        // La clave que libera los binarios. El doble la publica porque la
        // estrategia real lo hace: `clean_body` por si solo ya no acredita que
        // el texto saliera de un adjunto (ver `EXTRACTED_TEXT_KEYS`).
        extracted_text: TRANSCRIPTION,
        character_count: TRANSCRIPTION.length,
        ocr_status: 'COMPLETED',
      },
    });
    const llm = jest
      .fn()
      .mockResolvedValue({ success: true, data: { headline: 'Titular' } });

    factory.registerStrategy(
      buildStrategy(
        NodeType.TRIGGER_IMAP,
        jest.fn().mockResolvedValue({
          success: true,
          data: RAW_EMAIL_WITH_SCAN,
        }),
      ),
    );
    const parser = jest.fn().mockResolvedValue({
      success: false,
      error: {
        level: 'GRAVE',
        code: ERR_PARSER_UNEXTRACTABLE_MEDIA,
        message: 'El correo no trae texto aprovechable.',
      },
    });

    factory.registerStrategy(buildStrategy(NodeType.PARSER_PRE_IA, parser));
    factory.registerStrategy(buildStrategy(NodeType.PROCESADOR_OCR, ocr));
    factory.registerStrategy(buildStrategy(NodeType.PROCESADOR_IA, llm));

    return { ocr, llm, parser };
  };

  describe('1. Desvio hacia el satelite', () => {
    it('1.1 deberia saltar del parser a ocr_ia al emitir el codigo del rescate', async () => {
      // 1. Arrange 📐
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const { ocr } = registerStrategies();

      // 2. Act ⚙️
      await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildSchemaWithOcr(),
      );

      // 3. Assert 🎯
      expect(ocr).toHaveBeenCalledTimes(1);
    });

    it('1.2 deberia entregarle el contexto del fallo', async () => {
      // 1. Arrange 📐: es lo que distingue una invocacion de rescate de una
      //    normal, y lo que la trazabilidad usa para explicar por que corrio.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      registerStrategies();

      // 2. Act ⚙️
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildSchemaWithOcr(),
      );

      // 3. Assert 🎯
      expect(result.contextPayload.error_context).toMatchObject({
        failed_node_id: 'parser_pre_ia',
        error_code: ERR_PARSER_UNEXTRACTABLE_MEDIA,
      });
    });
  });

  describe('2. Purga de binarios (RNF-01)', () => {
    it('2.1 deberia dejar contentBase64 en null tras la transcripcion', async () => {
      // 1. Arrange 📐: la prueba que sostiene el diseno. `releaseAttachmentBinaries`
      //    es AGNOSTICO al tipo de nodo: decide por el vocabulario de claves de
      //    salida. Como el OCR publica `extracted_text` por encima del umbral de
      //    texto util, la purga se dispara sola, sin que `@core` sepa que existe
      //    un PROCESADOR_OCR.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      registerStrategies();

      // 2. Act ⚙️
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildSchemaWithOcr(),
      );

      // 3. Assert 🎯
      const attachments = (
        result.contextPayload.raw_email as {
          attachments: { contentBase64: string | null }[];
        }
      ).attachments;

      expect(attachments[0]?.contentBase64).toBeNull();
    });

    it('2.2 deberia conservar el resto del correo intacto', async () => {
      // 1. Arrange 📐: `setNamespace` FUSIONA por clave de primer nivel, asi que
      //    reescribir `attachments` no puede llevarse por delante el asunto ni
      //    el identificador del mensaje.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      registerStrategies();

      // 2. Act ⚙️
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildSchemaWithOcr(),
      );

      // 3. Assert 🎯
      expect(result.contextPayload.raw_email).toMatchObject({
        message_id: '<uno@unuware.com>',
        subject: 'Nota de prensa',
      });
    });
  });

  describe('3. Reincorporacion al camino nominal', () => {
    it('3.1 deberia continuar hasta el nodo de IA y cerrar EXITOSO', async () => {
      // 1. Arrange 📐: el satelite OCR NO es terminal, a diferencia del de
      //    alerta: su `nextStep` devuelve el flujo al curso que llevaba el
      //    parser, de modo que el correo acaba publicandose.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const { llm } = registerStrategies();

      // 2. Act ⚙️
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildSchemaWithOcr(),
      );

      // 3. Assert 🎯
      expect(llm).toHaveBeenCalledTimes(1);
      expect(result.currentState).toBe(ExecutionState.EXITOSO);
      expect(result.activeCursor).toBeNull();
    });

    it('3.2 deberia publicar ocr_result sin pisar parsed_email', async () => {
      // 1. Arrange 📐: namespace PROPIO es lo que permite que el satelite se
      //    auto-aprovisione. Compartir `llm_response` con el nodo de redaccion
      //    —o `parsed_email` con el parser— lo rechazaria la regla 5 del
      //    validador de topologia.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      registerStrategies();

      // 2. Act ⚙️
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildSchemaWithOcr(),
      );

      // 3. Assert 🎯
      expect(result.contextPayload.ocr_result).toEqual({
        clean_body: TRANSCRIPTION,
        extracted_text: TRANSCRIPTION,
        character_count: TRANSCRIPTION.length,
        ocr_status: 'COMPLETED',
      });
      // El parser de ESTA prueba falla sin payload, que es el caso de la
      // mayoria de las estrategias; por eso su namespace no llega a existir.
      // Que si exista cuando el parser SI produce algo lo cubre 3.4.
      expect(result.contextPayload.parsed_email).toBeUndefined();
    });

    it('3.4 deberia publicar parsed_email con el payload neutro del parser', async () => {
      // 1. Arrange 📐: el parser real NO se va de vacio —emite sus trece claves
      //    con `extracted_urls: []` y el inventario de adjuntos— y el motor las
      //    publica pese al `success: false`. Sin eso, el MAPEADOR_PLANTILLA que
      //    viene despues del rescate interpolaba un `{{parsed_email.*}}` que no
      //    existia, y el flujo moria por una contingencia que SI se atendio.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      registerStrategies();

      const neutralPayload = {
        subject: 'Nota de prensa',
        clean_body: '',
        extracted_urls: [],
        attachment_count: 1,
        requires_multimodal_fallback: true,
      };

      factory.registerStrategy(
        buildStrategy(
          NodeType.PARSER_PRE_IA,
          jest.fn().mockResolvedValue({
            success: false,
            data: { ...neutralPayload },
            error: {
              level: 'GRAVE',
              code: ERR_PARSER_UNEXTRACTABLE_MEDIA,
              message: 'El correo no trae texto aprovechable.',
            },
          }),
        ),
      );

      // 2. Act ⚙️
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildSchemaWithOcr(),
      );

      // 3. Assert 🎯
      expect(result.contextPayload.parsed_email).toEqual(neutralPayload);
      expect(result.currentState).toBe(ExecutionState.EXITOSO);
    });

    it('3.3 NO deberia reejecutar el parser que ya fallo', async () => {
      // 1. Arrange 📐: volver a el seria un ciclo —fallaria otra vez y se
      //    desviaria otra vez— que solo cortaria el circuit breaker de
      //    transiciones, y para entonces ya habria gastado cien vueltas.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const { parser } = registerStrategies();

      // 2. Act ⚙️
      await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildSchemaWithOcr(),
      );

      // 3. Assert 🎯
      expect(parser).toHaveBeenCalledTimes(1);
    });
  });
});
