import { createHash } from 'node:crypto';

import { UserRole } from '@modules/users/enums/user-role.enum';

import {
  InboundEmailResumeService,
  RESUME_MAIL_POLL_INTERVAL_MS,
  looksLikeResumeCommand,
  matchesStepWords,
  normalizeStepKey,
  STEP_ALIASES,
  tokenizeStepWords,
} from './inbound-email-resume.service';

import type { ConfigService } from '@nestjs/config';
import type { FsmExecutionQueryService } from '@core/fsm/services/fsm-execution-query.service';
import type { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import type { UsersService } from '@modules/users/users.service';
import type { Workflow } from '@modules/workflows/entities/workflow.entity';
import type { ExecutionsService } from './executions.service';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { NodeCatalogEntry } from '@modules/nodes/entities/node-catalog.entity';
import type { AlertQueryService } from '@modules/logs/services/alert-query.service';
import type { Repository } from 'typeorm';

const EXECUTION_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const FLOW_ID = 'b6c1f0d2-3e4a-4b5c-8d6e-7f8091a2b3c4';
const USER_ID = '9c1f7b52-4d3a-4e6b-8f2c-1a0b9d8e7f60';
const EDITOR_EMAIL = 'editor@unuware.com';
const TOKEN = 'a1b2c3d4e5f60718293a';

/** Huella tal como la persiste el nodo de pausa. */
const hashOf = (token: string): string =>
  createHash('sha256').update(token.trim().toLowerCase()).digest('hex');

/** Entorno con el canal encendido y bien configurado. */
const VALID_ENV: Record<string, string> = {
  INBOUND_RESUME_ENABLED: 'true',
  INBOUND_RESUME_IMAP_HOST: 'imap.unuware.com',
  INBOUND_RESUME_IMAP_USER: 'ordenes@unuware.com',
  INBOUND_RESUME_IMAP_PASSWORD_KEY: 'IMAP_ORDENES_PASSWORD',
  IMAP_ORDENES_PASSWORD: 'secreto',
};

/** Ejecucion detenida con su testigo ya publicado por el nodo de pausa. */
const buildExecution = (overrides: Partial<FsmExecution> = {}): FsmExecution =>
  ({
    executionId: EXECUTION_ID,
    flowId: FLOW_ID,
    activeCursor: 'nodo_c',
    contextPayload: {
      raw_email: { subject: 'Nota de prensa' },
      pause_context: {
        pausedAtStepId: 'pausa_revision',
        resumeStepId: 'nodo_c',
        resume_token_hash: hashOf(TOKEN),
        token_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    },
    ...overrides,
  }) as FsmExecution;

const buildUser = (overrides: Record<string, unknown> = {}) => ({
  id: USER_ID,
  email: EDITOR_EMAIL,
  role: UserRole.EDITOR,
  isActive: true,
  ...overrides,
});

/**
 * Filas del catalogo `nodos` que esta prueba necesita.
 *
 * Replican los pares `codigo`/`nombre` reales: son la unica fuente de la
 * etiqueta en espanol, porque el `pipeline_schema` no guarda ningun `name` ni
 * `label` por nodo.
 */
const CATALOG_ENTRIES = [
  { code: 'TRIGGER_IMAP', name: 'Disparador IMAP' },
  { code: 'PAUSA_FLOW', name: 'Pausa de Flujo' },
  { code: 'PROCESADOR_IA', name: 'Procesador de IA' },
];

const buildWorkflow = (): Workflow =>
  ({
    id: FLOW_ID,
    name: 'Notiweb',
    pipelineSchema: {
      entrypoint: 'nodo_a',
      nodes: {
        nodo_a: {
          nodeId: 'nodo_a',
          nodeType: 'TRIGGER_IMAP',
          outputNamespace: 'raw_email',
        },
        pausa_revision: {
          nodeId: 'pausa_revision',
          nodeType: 'PAUSA_FLOW',
          outputNamespace: 'pause_context',
        },
        nodo_c: {
          nodeId: 'nodo_c',
          nodeType: 'PROCESADOR_IA',
          outputNamespace: 'llm_response',
        },
      },
    },
  }) as unknown as Workflow;

interface Harness {
  service: InboundEmailResumeService;
  executions: { resumeExecution: jest.Mock };
  users: { findByEmail: jest.Mock };
  workflows: { findOne: jest.Mock };
  nodeCatalog: { find: jest.Mock };
  alertQuery: { findLastNodeErrorCode: jest.Mock };
  client: {
    connect: jest.Mock;
    getMailboxLock: jest.Mock;
    search: jest.Mock;
    download: jest.Mock;
    messageFlagsAdd: jest.Mock;
    logout: jest.Mock;
    close: jest.Mock;
    on: jest.Mock;
    usable: boolean;
  };
  warnSpy: jest.SpyInstance;
  errorSpy: jest.SpyInstance;
}

/**
 * Doble del cliente IMAP, devuelto por la factoria mockeada.
 *
 * Se sustituye la LECTURA del buzon, nunca la logica de validacion: lo que
 * estas pruebas examinan es a quien se le concede reanudar y a quien no.
 */
const mockClient = {} as Harness['client'];

// Se sustituye SOLO la construccion del cliente. `closeImapClientQuietly` entra
// por `requireActual` a proposito: es la pieza que decide si se despide la
// sesion y que destruye el socket siempre, y doblarla dejaria sin verificar
// justo el cierre que estas pruebas afirman.
jest.mock('@modules/nodes/services/imap-client.factory', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@modules/nodes/services/imap-client.factory',
  ),
  createImapClient: jest.fn(() => mockClient),
}));

const { createImapClient } = jest.requireMock<{
  createImapClient: jest.Mock;
}>('@modules/nodes/services/imap-client.factory');

jest.mock('mailparser', () => ({
  simpleParser: jest.fn(),
}));

const { simpleParser } = jest.requireMock<{ simpleParser: jest.Mock }>(
  'mailparser',
);

/**
 * Mensaje tal como lo devuelve `simpleParser`.
 *
 * El `text` es opcional porque la lectura tiene DOS vias y el asunto es la de
 * respaldo: las pruebas que no hablan del cuerpo siguen describiendo el caso
 * por asunto sin tener que declararlo.
 */
const inboundMessage = (
  subject: string,
  address: string = EDITOR_EMAIL,
  text = '',
): Record<string, unknown> => ({
  subject,
  text,
  from: { value: [{ address }], text: address },
});

const buildHarness = (
  env: Record<string, string> = VALID_ENV,
  execution: FsmExecution | null = buildExecution(),
): Harness => {
  const client: Harness['client'] = {
    connect: jest.fn().mockResolvedValue(undefined),
    getMailboxLock: jest.fn().mockResolvedValue({ release: jest.fn() }),
    search: jest.fn().mockResolvedValue([7]),
    download: jest.fn().mockResolvedValue({ content: 'raw' }),
    messageFlagsAdd: jest.fn().mockResolvedValue(undefined),
    logout: jest.fn().mockResolvedValue(undefined),
    close: jest.fn(),
    on: jest.fn(),
    usable: true,
  };

  // Se vuelca sobre el doble COMPARTIDO y es el compartido lo que se devuelve:
  // la factoria entrega `mockClient`, asi que una prueba que ajuste un campo
  // por valor —`usable`, no un mock— sobre una copia local no lo veria el
  // servicio.
  Object.assign(mockClient, client);

  const executions = {
    resumeExecution: jest.fn().mockResolvedValue({ status: 'EXITOSO' }),
  };
  const users = { findByEmail: jest.fn().mockResolvedValue(buildUser()) };
  const query = {
    findPausedWithContext: jest
      .fn()
      .mockResolvedValue(execution === null ? [] : [execution]),
  };
  const repository = {
    findOne: jest.fn().mockResolvedValue(buildWorkflow()),
  };
  // Catalogo de tipos de nodo: de el sale la etiqueta en espanol con la que un
  // operador nombra un paso de memoria ("DESDE Disparador IMAP").
  const nodeCatalog = {
    find: jest.fn().mockResolvedValue(CATALOG_ENTRIES),
  };
  // Traza de nodos: sin fallo previo por defecto, de modo que la guarda
  // anti-bucle del escudo no interviene salvo en las pruebas que la ejercitan.
  const alertQuery = {
    findLastNodeErrorCode: jest.fn().mockResolvedValue(null),
  };
  const config = {
    get: jest.fn((key: string) => env[key]),
  };
  // El planificador no se ejercita aqui: `onModuleInit` no se invoca en estas
  // pruebas, que describen el despacho y no el ciclo de vida del modulo.
  const scheduler = {
    addInterval: jest.fn(),
    deleteInterval: jest.fn(),
    doesExist: jest.fn().mockReturnValue(false),
  };

  const service = new InboundEmailResumeService(
    config as unknown as ConfigService,
    query as unknown as FsmExecutionQueryService,
    executions as unknown as ExecutionsService,
    users as unknown as UsersService,
    repository as unknown as Repository<Workflow>,
    nodeCatalog as unknown as Repository<NodeCatalogEntry>,
    scheduler as unknown as SchedulerRegistry,
    alertQuery as unknown as AlertQueryService,
  );

  jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'debug').mockImplementation(() => undefined);
  const errorSpy = jest
    .spyOn(service['logger'], 'error')
    .mockImplementation(() => undefined);
  const warnSpy = jest
    .spyOn(service['logger'], 'warn')
    .mockImplementation(() => undefined);

  return {
    service,
    executions,
    users,
    workflows: repository,
    client: mockClient,
    nodeCatalog,
    alertQuery,
    warnSpy,
    errorSpy,
  };
};

describe('InboundEmailResumeService (ordenes de reanudacion por correo)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    simpleParser.mockResolvedValue(inboundMessage(`REANUDAR ${TOKEN}`));
  });

  describe('1. Interruptor del canal', () => {
    it('1.1 NO deberia abrir el buzon con el canal apagado', async () => {
      // 1. Arrange 📐: apagado por defecto. Una instalacion que no lo configure
      //    no abre conexion ni expone superficie.
      const { service, client } = buildHarness({
        INBOUND_RESUME_ENABLED: 'false',
      });

      // 2. Act ⚙️
      const dispatched = await service.processInbox();

      // 3. Assert 🎯
      expect(dispatched).toBe(0);
      expect(client.connect).not.toHaveBeenCalled();
    });

    it('1.2 NO deberia abrir el buzon con la configuracion incompleta', async () => {
      // 1. Arrange 📐
      const { service, client } = buildHarness({
        INBOUND_RESUME_ENABLED: 'true',
      });

      // 2. Act ⚙️
      await service.processInbox();

      // 3. Assert 🎯
      expect(client.connect).not.toHaveBeenCalled();
    });

    it('1.3 deberia RECHAZAR una clave que no cumple el patron IMAP_*PASSWORD', async () => {
      // 1. Arrange 📐: sin esta guarda, apuntarla a `JWT_SECRET` entregaria el
      //    secreto de firma al servidor de correo en la autenticacion.
      const { service, client } = buildHarness({
        ...VALID_ENV,
        INBOUND_RESUME_IMAP_PASSWORD_KEY: 'JWT_SECRET',
      });

      // 2. Act ⚙️
      await service.processInbox();

      // 3. Assert 🎯
      expect(client.connect).not.toHaveBeenCalled();
    });
  });

  describe('2. El testigo es la credencial', () => {
    it('2.1 deberia reanudar con un testigo valido', async () => {
      // 1. Arrange 📐
      const { service, executions } = buildHarness();

      // 2. Act ⚙️
      const dispatched = await service.processInbox();

      // 3. Assert 🎯
      expect(dispatched).toBe(1);
      expect(executions.resumeExecution).toHaveBeenCalledWith(
        EXECUTION_ID,
        {},
        { id: USER_ID, email: EDITOR_EMAIL, role: UserRole.EDITOR },
        { isEmailResume: true },
      );
    });

    it('2.2 deberia RECHAZAR un testigo desconocido', async () => {
      // 1. Arrange 📐: es tambien el caso del testigo YA USADO. Al reanudar, la
      //    ejecucion deja de estar PAUSADO y no vuelve a ser candidata, asi que
      //    el unico uso se obtiene sin tabla ni migracion.
      const { service, executions, warnSpy } = buildHarness();
      simpleParser.mockResolvedValue(
        inboundMessage('REANUDAR 00000000000000000000'),
      );

      // 2. Act ⚙️
      await service.processInbox();

      // 3. Assert 🎯
      expect(executions.resumeExecution).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Intento no autorizado desde'),
      );
    });

    it('2.3 deberia RECHAZAR un testigo caducado', async () => {
      // 1. Arrange 📐
      const { service, executions } = buildHarness(VALID_ENV, {
        ...buildExecution(),
        contextPayload: {
          pause_context: {
            resume_token_hash: hashOf(TOKEN),
            token_expires_at: new Date(Date.now() - 1_000).toISOString(),
          },
        },
      });

      // 2. Act ⚙️
      await service.processInbox();

      // 3. Assert 🎯
      expect(executions.resumeExecution).not.toHaveBeenCalled();
    });

    it('2.4 NO deberia preguntar por el remitente antes que por el testigo', async () => {
      // 1. Arrange 📐: el orden importa. Consultar `usuarios` con el remitente
      //    de un mensaje cualquiera convertiria el buzon en un oraculo de que
      //    direcciones estan dadas de alta.
      const { service, users } = buildHarness();
      simpleParser.mockResolvedValue(
        inboundMessage('REANUDAR 00000000000000000000'),
      );

      // 2. Act ⚙️
      await service.processInbox();

      // 3. Assert 🎯
      expect(users.findByEmail).not.toHaveBeenCalled();
    });
  });

  describe('3. El remitente, como segundo factor', () => {
    it('3.1 deberia RECHAZAR a quien no esta dado de alta', async () => {
      // 1. Arrange 📐
      const { service, executions, users, warnSpy } = buildHarness();
      users.findByEmail.mockResolvedValue(null);
      simpleParser.mockResolvedValue(
        inboundMessage(`REANUDAR ${TOKEN}`, 'atacante@gmail.com'),
      );

      // 2. Act ⚙️
      await service.processInbox();

      // 3. Assert 🎯
      expect(executions.resumeExecution).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('atacante@gmail.com'),
      );
    });

    it('3.2 deberia RECHAZAR a un usuario dado de baja', async () => {
      // 1. Arrange 📐: el borrado es logico, asi que la fila sigue ahi.
      const { service, executions, users } = buildHarness();
      users.findByEmail.mockResolvedValue(buildUser({ isActive: false }));

      // 2. Act ⚙️
      await service.processInbox();

      // 3. Assert 🎯
      expect(executions.resumeExecution).not.toHaveBeenCalled();
    });

    it('3.3 deberia ACEPTAR a un ADMIN', async () => {
      // 1. Arrange 📐: los mismos dos roles que admite la API.
      const { service, executions, users } = buildHarness();
      users.findByEmail.mockResolvedValue(buildUser({ role: UserRole.ADMIN }));

      // 2. Act ⚙️
      await service.processInbox();

      // 3. Assert 🎯
      expect(executions.resumeExecution).toHaveBeenCalledTimes(1);
    });

    it('3.4 deberia RECHAZAR un mensaje sin remitente legible', async () => {
      // 1. Arrange 📐
      const { service, executions } = buildHarness();
      simpleParser.mockResolvedValue({ subject: `REANUDAR ${TOKEN}` });

      // 2. Act ⚙️
      await service.processInbox();

      // 3. Assert 🎯
      expect(executions.resumeExecution).not.toHaveBeenCalled();
    });
  });

  describe('4. Resolucion del paso destino', () => {
    it.each([
      ['identificador', 'pausa_revision', 'pausa_revision'],
      ['tipo de nodo', 'PROCESADOR_IA', 'nodo_c'],
      ['namespace', 'llm_response', 'nodo_c'],
      ['etiqueta del catalogo', 'Disparador IMAP', 'nodo_a'],
      ['etiqueta en minusculas', 'disparador imap', 'nodo_a'],
      ['etiqueta con tilde', 'Procesador de IÁ', 'nodo_c'],
    ])(
      '4.x deberia resolver el paso por su %s',
      async (_label, written, expected) => {
        // 1. Arrange 📐: las CUATRO formas con las que una persona nombra un
        //    paso de memoria. Lo que viaja al servicio es SIEMPRE el `nodeId`,
        //    que es lo unico que el motor entiende.
        //
        //    La etiqueta es la que de verdad usa un operador y la unica que no
        //    vive en el esquema: sale de la tabla `nodos`.
        const { service, executions } = buildHarness();
        simpleParser.mockResolvedValue(
          inboundMessage(`REANUDAR ${TOKEN} DESDE ${written}`),
        );

        // 2. Act ⚙️
        await service.processInbox();

        // 3. Assert 🎯
        expect(executions.resumeExecution).toHaveBeenCalledWith(
          EXECUTION_ID,
          { targetStepId: expected },
          expect.anything(),
          { isEmailResume: true },
        );
      },
    );

    it('4.4 NO deberia distinguir mayusculas', async () => {
      // 1. Arrange 📐: el asunto pasa por varios clientes que lo reescriben.
      const { service, executions } = buildHarness();
      simpleParser.mockResolvedValue(
        inboundMessage(`reanudar ${TOKEN} desde PAUSA_REVISION`),
      );

      // 2. Act ⚙️
      await service.processInbox();

      // 3. Assert 🎯
      expect(executions.resumeExecution).toHaveBeenCalledWith(
        EXECUTION_ID,
        { targetStepId: 'pausa_revision' },
        expect.anything(),
        { isEmailResume: true },
      );
    });

    it('4.5 deberia reanudar desde el cursor si el paso no existe', async () => {
      // 1. Arrange 📐: abortar por una errata en un nombre dejaria el flujo
      //    parado por un detalle que el correo no permite corregir.
      const { service, executions } = buildHarness();
      simpleParser.mockResolvedValue(
        inboundMessage(`REANUDAR ${TOKEN} DESDE nodo_fantasma`),
      );

      // 2. Act ⚙️
      await service.processInbox();

      // 3. Assert 🎯
      expect(executions.resumeExecution).toHaveBeenCalledWith(
        EXECUTION_ID,
        {},
        expect.anything(),
        { isEmailResume: true },
      );
    });

    it('4.6 deberia aceptar una etiqueta con espacios en el ASUNTO', async () => {
      // 1. Arrange 📐: REGRESION. El grupo del paso era `[a-zA-Z0-9_-]+` y la
      //    expresion esta anclada de punta a punta, asi que una orden con un
      //    nombre de dos palabras no casaba con NADA: el mensaje se descartaba
      //    como "esto no es una orden" y ni siquiera se reanudaba desde el
      //    cursor. Fallaba en silencio, que es lo peor que podia hacer.
      const { service, executions } = buildHarness();
      simpleParser.mockResolvedValue({
        subject: `Re: REANUDAR ${TOKEN} DESDE Disparador IMAP`,
        from: { value: [{ address: EDITOR_EMAIL }], text: EDITOR_EMAIL },
      });

      // 2. Act ⚙️
      await service.processInbox();

      // 3. Assert 🎯
      expect(executions.resumeExecution).toHaveBeenCalledWith(
        EXECUTION_ID,
        { targetStepId: 'nodo_a' },
        expect.anything(),
        { isEmailResume: true },
      );
    });

    it('4.7 deberia resolver por alias aunque el catalogo no responda', async () => {
      // 1. Arrange 📐: «Disparador IMAP» es un alias fijo de TRIGGER_IMAP
      //    (`STEP_ALIASES`), asi que no depende de la tabla `nodos`.
      const { service, executions, nodeCatalog } = buildHarness();
      nodeCatalog.find.mockRejectedValue(new Error('Base no disponible'));
      simpleParser.mockResolvedValue(
        inboundMessage(`REANUDAR ${TOKEN} DESDE Disparador IMAP`),
      );

      // 2. Act ⚙️
      await service.processInbox();

      // 3. Assert 🎯
      expect(executions.resumeExecution).toHaveBeenCalledWith(
        EXECUTION_ID,
        { targetStepId: 'nodo_a' },
        expect.anything(),
        { isEmailResume: true },
      );
    });

    it('4.8 deberia reanudar desde el cursor si el paso no se reconoce y el catalogo no responde', async () => {
      // 1. Arrange 📐: perder la forma comoda de nombrar un paso es un
      //    inconveniente; dejar sin reanudar un flujo detenido porque la tabla
      //    `nodos` no contesto seria el fallo de verdad.
      const { service, executions, nodeCatalog } = buildHarness();
      nodeCatalog.find.mockRejectedValue(new Error('Base no disponible'));
      simpleParser.mockResolvedValue(
        inboundMessage(`REANUDAR ${TOKEN} DESDE Revision editorial`),
      );

      // 2. Act ⚙️
      await service.processInbox();

      // 3. Assert 🎯: se reanuda igual, solo que sin el paso pedido.
      expect(executions.resumeExecution).toHaveBeenCalledWith(
        EXECUTION_ID,
        {},
        expect.anything(),
        { isEmailResume: true },
      );
    });

    it.each([
      ['errata DESE', `REANUDAR ${TOKEN} DESE trigger imap`, 'nodo_a'],
      ['errata DE', `REANUDAR ${TOKEN} DE trigger imap`, 'nodo_a'],
      ['guion', `REANUDAR ${TOKEN} DESDE disparador-imap`, 'nodo_a'],
      [
        'guion bajo y tildes',
        `Reanudár ${TOKEN} desde procesador_de_ía`,
        'nodo_c',
      ],
      ['verbo RESUME', `RESUME ${TOKEN} FROM pausa`, 'pausa_revision'],
    ])(
      '4.9 deberia tolerar la variante "%s"',
      async (_label, line, expected) => {
        // 1. Arrange 📐
        const { service, executions } = buildHarness();
        simpleParser.mockResolvedValue(inboundMessage(line));

        // 2. Act ⚙️
        await service.processInbox();

        // 3. Assert 🎯
        expect(executions.resumeExecution).toHaveBeenCalledWith(
          EXECUTION_ID,
          { targetStepId: expected },
          expect.anything(),
          { isEmailResume: true },
        );
      },
    );
  });

  describe('4bis. Prioridad secuencial y diccionario de sinonimos', () => {
    const resumeFrom = async (
      written: string,
      extraNodes: Record<string, Record<string, unknown>> = {},
    ): Promise<jest.Mock> => {
      const { service, executions, workflows } = buildHarness();
      const workflow = buildWorkflow() as unknown as {
        pipelineSchema: { nodes: Record<string, unknown> };
      };
      workflows.findOne.mockResolvedValue({
        ...workflow,
        pipelineSchema: {
          ...workflow.pipelineSchema,
          nodes: { ...workflow.pipelineSchema.nodes, ...extraNodes },
        },
      });
      simpleParser.mockResolvedValue(
        inboundMessage(`REANUDAR ${TOKEN} DESDE ${written}`),
      );
      await service.processInbox();

      return executions.resumeExecution;
    };

    it.each(['Destino Drupal', 'destino-drupal', 'DESTINO_DRUPAL', 'drupal'])(
      '4bis.1 deberia resolver "%s" al nodo DESTINO_DRUPAL',
      async (written) => {
        // 1. Arrange 📐 + 2. Act ⚙️
        const resume = await resumeFrom(written, {
          destino: { nodeId: 'destino', nodeType: 'DESTINO_DRUPAL' },
        });

        // 3. Assert 🎯
        expect(resume).toHaveBeenCalledWith(
          EXECUTION_ID,
          { targetStepId: 'destino' },
          expect.anything(),
          { isEmailResume: true },
        );
      },
    );

    it.each([
      [
        'render html',
        'mapeo',
        { nodeId: 'mapeo', nodeType: 'MAPEADOR_PLANTILLA' },
      ],
      ['pause_context', 'pausa_revision', null],
    ])(
      '4bis.2 deberia resolver el sinonimo "%s"',
      async (written, expected, node) => {
        // 1. Arrange 📐 + 2. Act ⚙️
        const resume = await resumeFrom(
          written,
          node === null ? {} : { [expected]: node },
        );

        // 3. Assert 🎯
        expect(resume).toHaveBeenCalledWith(
          EXECUTION_ID,
          { targetStepId: expected },
          expect.anything(),
          { isEmailResume: true },
        );
      },
    );

    it('4bis.3 la etiqueta visible deberia ganar al diccionario', async () => {
      // 1. Arrange 📐: «Drupal» es sinonimo de DESTINO_DRUPAL, pero hay un
      //    nodo cuya etiqueta en el canvas es literalmente «Drupal».
      const resume = await resumeFrom('Drupal', {
        destino: { nodeId: 'destino', nodeType: 'DESTINO_DRUPAL' },
        aviso: { nodeId: 'aviso', nodeType: 'DESTINO_HTTP', label: 'Drupal' },
      });

      // 3. Assert 🎯
      expect(resume).toHaveBeenCalledWith(
        EXECUTION_ID,
        { targetStepId: 'aviso' },
        expect.anything(),
        { isEmailResume: true },
      );
    });
  });
  describe('4ter. Coincidencia por bolsa de palabras', () => {
    /** Nodo mapeador SIN etiqueta: solo lo nombran su id y su tipo. */
    const MAPPER_NODE = {
      mapeador_plantilla: {
        nodeId: 'mapeador_plantilla',
        nodeType: 'MAPEADOR_PLANTILLA',
        outputNamespace: 'rendered_html',
      },
    };

    const resumeFrom = async (
      written: string,
      extraNodes: Record<string, Record<string, unknown>> = MAPPER_NODE,
    ): Promise<Harness> => {
      const harness = buildHarness();
      const workflow = buildWorkflow() as unknown as {
        pipelineSchema: { nodes: Record<string, unknown> };
      };
      harness.workflows.findOne.mockResolvedValue({
        ...workflow,
        pipelineSchema: {
          ...workflow.pipelineSchema,
          nodes: { ...workflow.pipelineSchema.nodes, ...extraNodes },
        },
      });
      simpleParser.mockResolvedValue(
        inboundMessage(`REANUDAR ${TOKEN} DESDE ${written}`),
      );
      await harness.service.processInbox();

      return harness;
    };

    const expectResumedFrom = (
      harness: Harness,
      targetStepId: string,
    ): void => {
      expect(harness.executions.resumeExecution).toHaveBeenCalledWith(
        EXECUTION_ID,
        { targetStepId },
        expect.anything(),
        { isEmailResume: true },
      );
    };

    it('4ter.1 deberia resolver "MAPEADOR DE PLANTILLA" a mapeador_plantilla', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const harness = await resumeFrom('MAPEADOR DE PLANTILLA');

      // 3. Assert 🎯
      expectResumedFrom(harness, 'mapeador_plantilla');
    });

    it('4ter.2 deberia resolver el orden invertido "plantilla mapeador"', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️: ningun nivel estricto lo entiende —la clave
      //    compacta "plantillamapeador" no es id, tipo ni sinonimo—; solo la
      //    bolsa de palabras, que parte `mapeador_plantilla` por el `_`.
      const harness = await resumeFrom('plantilla mapeador');

      // 3. Assert 🎯
      expectResumedFrom(harness, 'mapeador_plantilla');
      expect(harness.warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('no existe en el flujo'),
      );
    });

    it('4ter.3 deberia resolver "Mapeador de Plantillas" por el nombre visual del nodo', async () => {
      // 1. Arrange 📐: el plural no casa con el id ni con el tipo; lo resuelve
      //    la etiqueta que el operador ve en el canvas.
      const harness = await resumeFrom('Mapeador de Plantillas', {
        mapeo: {
          nodeId: 'mapeo',
          nodeType: 'MAPEADOR_PLANTILLA',
          outputNamespace: 'rendered_html',
          label: 'Mapeador de Plantillas',
        },
      });

      // 3. Assert 🎯
      expectResumedFrom(harness, 'mapeo');
    });

    it('4ter.4 deberia volver al activeCursor si "PASO_INEXISTENTE" no nombra ningun nodo', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const harness = await resumeFrom('PASO_INEXISTENTE');

      // 3. Assert 🎯: sin `targetStepId`, el motor reanuda desde el cursor
      //    persistido; la orden no se aborta por una errata.
      expect(harness.executions.resumeExecution).toHaveBeenCalledWith(
        EXECUTION_ID,
        {},
        expect.anything(),
        { isEmailResume: true },
      );
      expect(harness.warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('"PASO_INEXISTENTE" no existe en el flujo'),
      );
    });

    it('4ter.5 deberia elegir el primero declarado y avisar si las palabras nombran a varios', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️: «revision pausa» casa por palabras con dos
      //    nodos (ninguno por etiqueta, id, tipo ni sinonimo exactos).
      const harness = await resumeFrom('revision pausa', {
        pausa_revision_final: {
          nodeId: 'pausa_revision_final',
          nodeType: 'PAUSA_FLOW',
          outputNamespace: 'pause_final',
        },
      });

      // 3. Assert 🎯
      expectResumedFrom(harness, 'pausa_revision');
      expect(harness.warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('nombra a varios nodos'),
      );
    });

    it('4ter.6 un sinonimo exacto deberia ganar a la bolsa de palabras', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️: «ia» casaria por palabras con
      //    `escudo_post_ia`, declarado antes, pero el diccionario lo resuelve
      //    al PROCESADOR_IA en un nivel previo.
      const harness = await resumeFrom('ia', {
        escudo_post_ia: {
          nodeId: 'escudo_post_ia',
          nodeType: 'ESCUDO_POST_IA',
          outputNamespace: 'validated_drupal_json',
        },
      });

      // 3. Assert 🎯
      expectResumedFrom(harness, 'nodo_c');
    });
  });

  describe('5. Higiene del buzon', () => {
    it('5.1 deberia marcar como leido un comando ACEPTADO', async () => {
      // 1. Arrange 📐
      const { service, client } = buildHarness();

      // 2. Act ⚙️
      await service.processInbox();

      // 3. Assert 🎯
      expect(client.messageFlagsAdd).toHaveBeenCalledWith('7', ['\\Seen'], {
        uid: true,
      });
    });

    it('5.2 deberia marcar como leido un comando RECHAZADO', async () => {
      // 1. Arrange 📐: sin esto, un intento no autorizado se reprocesaria en
      //    cada vuelta y llenaria el registro de la misma advertencia.
      const { service, client, users } = buildHarness();
      users.findByEmail.mockResolvedValue(null);

      // 2. Act ⚙️
      await service.processInbox();

      // 3. Assert 🎯
      expect(client.messageFlagsAdd).toHaveBeenCalledTimes(1);
    });

    it('5.3 NO deberia marcar como leido un mensaje que no es una orden', async () => {
      // 1. Arrange 📐: INVERSION DELIBERADA de lo que esta prueba exigia antes.
      //    Marcar todo lo que se leia convertia este canal en un lector que
      //    vaciaba de no-leidos un buzon que puede ser el MISMO que sondea un
      //    `TRIGGER_IMAP`: el flujo configurado con `markAsRead: false` veia su
      //    correo marcado por la espalda y nadie podia explicar por que.
      const { service, client, executions } = buildHarness();
      simpleParser.mockResolvedValue(inboundMessage('Re: dudas del boletin'));

      // 2. Act ⚙️
      await service.processInbox();

      // 3. Assert 🎯
      expect(executions.resumeExecution).not.toHaveBeenCalled();
      expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    });

    it('5.5 no deberia volver a descargar un mensaje ya descartado', async () => {
      // 1. Arrange 📐: contrapartida del cambio anterior. Al no marcarlos, el
      //    servidor los sigue devolviendo en cada busqueda de no-leidos; sin el
      //    recuerdo en memoria, una conversacion larga coparia las plazas del
      //    lote y las ordenes reales no se atenderian nunca.
      const { service, client } = buildHarness();
      simpleParser.mockResolvedValue(inboundMessage('Re: dudas del boletin'));

      // 2. Act ⚙️: dos vueltas sobre el mismo buzon con el mismo uid.
      await service.processInbox();
      await service.processInbox();

      // 3. Assert 🎯: se descargo UNA vez, no una por vuelta.
      expect(client.download).toHaveBeenCalledTimes(1);
    });

    it('5.4 deberia cerrar la sesion aunque la lectura falle', async () => {
      // 1. Arrange 📐: una conexion IMAP que no se cierra agota el limite de
      //    sesiones del proveedor en unas pocas vueltas.
      const { service, client } = buildHarness();
      client.search.mockRejectedValue(new Error('Conexion perdida'));

      // 2. Act ⚙️
      const dispatched = await service.processInbox();

      // 3. Assert 🎯
      expect(dispatched).toBe(0);
      expect(client.logout).toHaveBeenCalledTimes(1);
    });

    it('5.5 NO deberia dejar que un mensaje roto bloquee a los siguientes', async () => {
      // 1. Arrange 📐
      const { service, client, executions } = buildHarness();
      client.search.mockResolvedValue([7, 8]);
      simpleParser
        .mockRejectedValueOnce(new Error('MIME corrupto'))
        .mockResolvedValueOnce(inboundMessage(`REANUDAR ${TOKEN}`));

      // 2. Act ⚙️
      const dispatched = await service.processInbox();

      // 3. Assert 🎯
      expect(dispatched).toBe(1);
      expect(executions.resumeExecution).toHaveBeenCalledTimes(1);
    });
    it('5.6 deberia buscar EXCLUSIVAMENTE mensajes no leidos', async () => {
      // 1. Arrange 📐: un correo ya leido no se inspecciona bajo ningun concepto.
      const { service, client } = buildHarness();

      // 2. Act ⚙️
      await service.processInbox();

      // 3. Assert 🎯
      expect(client.search).toHaveBeenCalledWith(
        { seen: false },
        { uid: true },
      );
    });

    it('5.7 deberia atender en orden todas las respuestas del hilo aunque una falle', async () => {
      // 1. Arrange 📐: tres respuestas al mismo aviso, devueltas desordenadas
      //    por el servidor; la del medio trae un MIME roto.
      const { service, client } = buildHarness();
      client.search.mockResolvedValue([12, 10, 11]);
      simpleParser
        .mockResolvedValueOnce(inboundMessage(`REANUDAR ${TOKEN}`))
        .mockRejectedValueOnce(new Error('MIME corrupto'))
        .mockResolvedValueOnce(inboundMessage(`REANUDAR ${TOKEN} DESE pausa`));

      // 2. Act ⚙️
      await service.processInbox();

      // 3. Assert 🎯: descargadas en orden de llegada y las tres retiradas.
      expect(
        client.download.mock.calls.map((call: unknown[]) => call[0]),
      ).toEqual(['10', '11', '12']);
      expect(client.messageFlagsAdd).toHaveBeenCalledTimes(3);
    });
  });

  describe('5bis. Normalizacion del texto de reanudacion (helpers puros)', () => {
    it('5bis.1 deberia compactar tildes, mayusculas, espacios y signos', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(normalizeStepKey('Destino Drupal')).toBe('destinodrupal');
      expect(normalizeStepKey('  Escudo Post-IA ')).toBe('escudopostia');
      expect(normalizeStepKey('Procesador  de   IÁ')).toBe('procesadordeia');
      expect(normalizeStepKey('DESTINO_DRUPAL')).toBe('destinodrupal');
    });

    it.each([
      ['trigger imap', 'TRIGGER_IMAP'],
      ['disparador-imap', 'TRIGGER_IMAP'],
      ['extractor web', 'EXTRACTOR_WEB'],
      ['scraper', 'EXTRACTOR_WEB'],
      ['ocr_ia', 'PROCESADOR_OCR'],
      ['mapeador html', 'MAPEADOR_PLANTILLA'],
      ['rendered_html', 'MAPEADOR_PLANTILLA'],
      ['llm_response', 'PROCESADOR_IA'],
      ['post_ia', 'ESCUDO_POST_IA'],
      ['pausa flow', 'PAUSA_FLOW'],
      ['pause_context', 'PAUSA_FLOW'],
      ['drupal', 'DESTINO_DRUPAL'],
    ])('5bis.2 deberia mapear el sinonimo "%s" a %s', (alias, expected) => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(STEP_ALIASES[normalizeStepKey(alias)]).toBe(expected);
    });

    it('5bis.3 deberia reconocer la pista de orden con prefijos y tildes', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(looksLikeResumeCommand(`Re: RE: reanudár ${TOKEN}`)).toBe(true);
      expect(looksLikeResumeCommand(`RESUME ${TOKEN}`)).toBe(true);
      expect(looksLikeResumeCommand('Re: dudas del boletin')).toBe(false);
    });

    it('5bis.5 deberia partir el nombre de un paso como el filtro de asunto del Trigger', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯: `_` separa, las tildes se
      //    pliegan y los articulos y preposiciones se descartan.
      expect(tokenizeStepWords('MAPEADOR_PLANTILLA')).toEqual([
        'mapeador',
        'plantilla',
      ]);
      expect(tokenizeStepWords('el Mapeador de la Plantilla')).toEqual([
        'mapeador',
        'plantilla',
      ]);
      expect(tokenizeStepWords('Extracción Web')).toEqual([
        'extraccion',
        'web',
      ]);
      expect(tokenizeStepWords('de la')).toEqual([]);
    });

    it('5bis.6 deberia exigir todas las palabras pedidas, en cualquier orden', () => {
      // 1. Arrange 📐
      const candidate = new Set(['mapeador', 'plantilla', 'rendered', 'html']);

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(matchesStepWords(['plantilla', 'mapeador'], candidate)).toBe(true);
      expect(matchesStepWords(['mapeador', 'web'], candidate)).toBe(false);
      expect(matchesStepWords([], candidate)).toBe(false);
    });

    it('5bis.4 deberia declarar una espera minima de sondeo de 5000 ms', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(RESUME_MAIL_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(5000);
    });
  });

  describe('6. Lectura del comando: el cuerpo manda, el asunto respalda', () => {
    /**
     * El asunto dejo de ser la unica via porque los clientes de correo
     * anteponen `Re:` al responder, y la orden llega SIEMPRE como respuesta al
     * aviso: un asunto que empiece literalmente por `REANUDAR` solo se
     * consigue editandolo a mano.
     */
    it('6.1 deberia leer la orden del CUERPO aunque el asunto sea el del aviso', async () => {
      // 1. Arrange 📐
      const { service, executions } = buildHarness();
      simpleParser.mockResolvedValue(
        inboundMessage(
          'Re: [Proto-Do] Flujo detenido',
          EDITOR_EMAIL,
          `REANUDAR ${TOKEN}`,
        ),
      );

      // 2. Act ⚙️
      const dispatched = await service.processInbox();

      // 3. Assert 🎯
      expect(dispatched).toBe(1);
      expect(executions.resumeExecution).toHaveBeenCalledTimes(1);
    });

    it('6.2 deberia descontar los `Re:` encadenados del asunto de respaldo', async () => {
      // 1. Arrange 📐: sin cuerpo util, que es lo que ocurre cuando el cliente
      //    solo adjunta una firma automatica.
      const { service, executions } = buildHarness();
      simpleParser.mockResolvedValue(
        inboundMessage(`RE: Re: Rv: REANUDAR ${TOKEN}`),
      );

      // 2. Act ⚙️
      const dispatched = await service.processInbox();

      // 3. Assert 🎯
      expect(dispatched).toBe(1);
      expect(executions.resumeExecution).toHaveBeenCalledTimes(1);
    });

    it('6.3 deberia descartar la CITA del aviso original', async () => {
      // 1. Arrange 📐: el aviso que se cita incluye literalmente el texto
      //    `REANUDAR <testigo>` que el propio sistema escribio. Sin cortar en
      //    la marca de cita, un "recibido, gracias" reanudaria el flujo.
      const { service, executions } = buildHarness();
      simpleParser.mockResolvedValue(
        inboundMessage(
          'Re: [Proto-Do] Flujo detenido',
          EDITOR_EMAIL,
          [
            'Recibido, gracias.',
            '',
            '> El 16/10/2026, Proto-Do escribio:',
            `> REANUDAR ${TOKEN}`,
          ].join('\n'),
        ),
      );

      // 2. Act ⚙️
      const dispatched = await service.processInbox();

      // 3. Assert 🎯
      expect(dispatched).toBe(0);
      expect(executions.resumeExecution).not.toHaveBeenCalled();
    });

    it('6.4 deberia rechazar un cuerpo con texto de mas detras de la orden', async () => {
      // 1. Arrange 📐: anclaje completo. Una respuesta larga que mencione el
      //    comando de pasada no puede reanudar nada.
      const { service, executions } = buildHarness();
      simpleParser.mockResolvedValue(
        inboundMessage(
          'Re: aviso',
          EDITOR_EMAIL,
          `REANUDAR ${TOKEN} por favor, es urgente`,
        ),
      );

      // 2. Act ⚙️
      const dispatched = await service.processInbox();

      // 3. Assert 🎯
      expect(dispatched).toBe(0);
      expect(executions.resumeExecution).not.toHaveBeenCalled();
    });

    it('6.5 deberia aceptar la orden con DESDE leida del cuerpo', async () => {
      // 1. Arrange 📐
      const { service, executions } = buildHarness();
      simpleParser.mockResolvedValue(
        inboundMessage(
          'Re: aviso',
          EDITOR_EMAIL,
          `REANUDAR ${TOKEN} DESDE pausa_revision`,
        ),
      );

      // 2. Act ⚙️
      await service.processInbox();

      // 3. Assert 🎯
      expect(executions.resumeExecution).toHaveBeenCalledWith(
        EXECUTION_ID,
        { targetStepId: 'pausa_revision' },
        expect.anything(),
        { isEmailResume: true },
      );
    });

    it('6.6 deberia ignorar una firma automatica por delante del comando', async () => {
      // 1. Arrange 📐: la firma va DETRAS en un cliente normal; si va delante,
      //    la primera linea util no es el comando y la orden no se entiende.
      //    Se documenta como limite conocido: el aviso pide escribir el
      //    comando como PRIMERA linea.
      const { service, executions } = buildHarness();
      simpleParser.mockResolvedValue(
        inboundMessage(
          'Re: aviso',
          EDITOR_EMAIL,
          `Enviado desde mi movil\n\nREANUDAR ${TOKEN}`,
        ),
      );

      // 2. Act ⚙️
      const dispatched = await service.processInbox();

      // 3. Assert 🎯
      expect(dispatched).toBe(0);
      expect(executions.resumeExecution).not.toHaveBeenCalled();
    });
  });

  describe('7. `processMessage` como puerta compartida', () => {
    /**
     * La misma validacion sirve a las DOS entradas: el barrido del buzon de
     * ordenes y `ImapTriggerStrategy`, que se topa con la orden en el buzon que
     * sondea el propio flujo. Duplicar la comprobacion del testigo y el RBAC en
     * la estrategia habria creado una segunda puerta con sus propias reglas.
     */
    it('7.1 deberia reanudar desde un mensaje ya parseado, sin tocar IMAP', async () => {
      // 1. Arrange 📐
      const { service, executions, client } = buildHarness();

      // 2. Act ⚙️
      const resumed = await service.processMessage(
        inboundMessage('Re: aviso', EDITOR_EMAIL, `REANUDAR ${TOKEN}`) as never,
      );

      // 3. Assert 🎯
      expect(resumed).toBe(true);
      expect(executions.resumeExecution).toHaveBeenCalledTimes(1);
      // No abre ninguna conexion: el mensaje ya venia descargado.
      expect(client.connect).not.toHaveBeenCalled();
    });

    it('7.2 deberia aplicar las MISMAS guardas que el barrido propio', async () => {
      // 1. Arrange 📐: remitente que no esta dado de alta, testigo valido.
      const { service, executions, users } = buildHarness();
      users.findByEmail.mockResolvedValue(null);

      // 2. Act ⚙️
      const resumed = await service.processMessage(
        inboundMessage(
          'Re: aviso',
          'ajeno@example.com',
          `REANUDAR ${TOKEN}`,
        ) as never,
      );

      // 3. Assert 🎯
      expect(resumed).toBe(false);
      expect(executions.resumeExecution).not.toHaveBeenCalled();
    });
  });

  /**
   * EL DEFECTO QUE CIERRA ESTE BLOQUE. Este canal no tenia NINGUNA guarda de
   * solapamiento —a diferencia del sondeo de flujos— ni destruia el socket al
   * acabar, de modo que un enlace lento apilaba una sesion IMAP por minuto
   * contra el mismo buzon y las ordenes se despachaban por duplicado.
   */
  describe('8. Resiliencia del enlace', () => {
    it('8.1 deberia aguantar una caida de red sin apagar el canal', async () => {
      // 1. Arrange 📐: la VPN se cae con el barrido ya en marcha.
      const { service, client, warnSpy, errorSpy } = buildHarness();
      client.usable = false;
      client.connect.mockRejectedValue(
        Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      );

      // 2. Act ⚙️
      const dispatched = await service.processInbox();

      // 3. Assert 🎯
      expect(dispatched).toBe(0);
      // El socket se destruye aunque no se pueda despedir la sesion.
      expect(client.logout).not.toHaveBeenCalled();
      expect(client.close).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Enlace no disponible temporalmente'),
      );
      // Un corte que se arregla solo no es una traza roja.
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('8.2 deberia volver a barrer en el ciclo siguiente tras la caida', async () => {
      // 1. Arrange 📐: la guarda de solapamiento no puede quedarse armada
      //    cuando el ciclo muere por una excepcion; el canal quedaria mudo para
      //    siempre sin un reinicio.
      const { service, client } = buildHarness();
      client.connect
        .mockRejectedValueOnce(new Error('Connection not available'))
        .mockResolvedValue(undefined);

      // 2. Act ⚙️
      await service.processInbox();
      await service.processInbox();

      // 3. Assert 🎯
      expect(client.search).toHaveBeenCalledTimes(1);
    });

    it('8.3 deberia descartar un tick solapado sin abrir una segunda sesion', async () => {
      // 1. Arrange 📐: el primer barrido se queda colgado a proposito.
      const { service, warnSpy } = buildHarness();
      let unblock: () => void = () => undefined;
      const pending = new Promise<void>((resolve) => {
        unblock = resolve;
      });

      const { client } = buildHarness();
      client.connect.mockReturnValue(pending);
      createImapClient.mockClear();

      // 2. Act ⚙️
      const first = service.processInbox();
      const second = await service.processInbox();
      unblock();
      await first;

      // 3. Assert 🎯: una sola sesion contra el buzon, no dos leyendo los
      //    mismos mensajes sin marcar.
      expect(second).toBe(0);
      expect(createImapClient).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('sigue en curso'),
      );
    });

    it('8.4 deberia cerrar el socket tambien en el barrido nominal', async () => {
      // 1. Arrange 📐
      const { service, client } = buildHarness();

      // 2. Act ⚙️
      await service.processInbox();

      // 3. Assert 🎯: despedida limpia Y destruccion, no una de las dos.
      expect(client.logout).toHaveBeenCalledTimes(1);
      expect(client.close).toHaveBeenCalledTimes(1);
    });

    it('8.5 deberia tratar el CONNECT_TIMEOUT de imapflow como aviso LEVE y cerrar el socket en el finally', async () => {
      // 1. Arrange 📐: el error exacto que imapflow fabrica cuando el servidor
      //    no completa la conexion a tiempo. Antes se registraba como averia.
      const { service, client, warnSpy, errorSpy } = buildHarness();
      client.usable = false;
      client.connect
        .mockRejectedValueOnce(
          Object.assign(
            new Error('Failed to establish connection in required time'),
            {
              code: 'CONNECT_TIMEOUT',
            },
          ),
        )
        .mockResolvedValue(undefined);

      // 2. Act ⚙️: un ciclo que expira y otro que ya conecta.
      const first = await service.processInbox();
      client.usable = true;
      await service.processInbox();

      // 3. Assert 🎯
      expect(first).toBe(0);
      expect(client.close).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Enlace no disponible temporalmente'),
      );
      expect(errorSpy).not.toHaveBeenCalled();
      // El ciclo siguiente no quedo bloqueado por la guarda de solapamiento.
      expect(client.search).toHaveBeenCalledTimes(1);
    });

    it('8.6 deberia abrir el cliente con timeouts explicitos de conexion, saludo y socket', async () => {
      // 1. Arrange 📐
      const { service } = buildHarness();
      createImapClient.mockClear();

      // 2. Act ⚙️
      await service.processInbox();

      // 3. Assert 🎯: 45 s para conectar, 30 s de saludo y 60 s de inactividad.
      expect(createImapClient).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.any(Function),
        {
          connectionTimeoutMs: 45_000,
          greetingTimeoutMs: 30_000,
          socketTimeoutMs: 60_000,
        },
      );
    });
  });
});
