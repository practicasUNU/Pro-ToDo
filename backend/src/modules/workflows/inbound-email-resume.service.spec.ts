import { createHash } from 'node:crypto';

import { UserRole } from '@modules/users/enums/user-role.enum';

import { InboundEmailResumeService } from './inbound-email-resume.service';

import type { ConfigService } from '@nestjs/config';
import type { FsmExecutionQueryService } from '@core/fsm/services/fsm-execution-query.service';
import type { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import type { UsersService } from '@modules/users/users.service';
import type { Workflow } from '@modules/workflows/entities/workflow.entity';
import type { ExecutionsService } from './executions.service';
import type { SchedulerRegistry } from '@nestjs/schedule';
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
  client: {
    connect: jest.Mock;
    getMailboxLock: jest.Mock;
    search: jest.Mock;
    download: jest.Mock;
    messageFlagsAdd: jest.Mock;
    logout: jest.Mock;
    close: jest.Mock;
    on: jest.Mock;
  };
  warnSpy: jest.SpyInstance;
}

/**
 * Doble del cliente IMAP, devuelto por la factoria mockeada.
 *
 * Se sustituye la LECTURA del buzon, nunca la logica de validacion: lo que
 * estas pruebas examinan es a quien se le concede reanudar y a quien no.
 */
const mockClient = {} as Harness['client'];

jest.mock('@modules/nodes/services/imap-client.factory', () => ({
  createImapClient: jest.fn(() => mockClient),
}));

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
  };

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
    scheduler as unknown as SchedulerRegistry,
  );

  jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'debug').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  const warnSpy = jest
    .spyOn(service['logger'], 'warn')
    .mockImplementation(() => undefined);

  return { service, executions, users, client, warnSpy };
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
    ])(
      '4.x deberia resolver el paso por su %s',
      async (_label, written, expected) => {
        // 1. Arrange 📐: las tres formas con las que una persona nombra un
        //    paso de memoria. Lo que viaja al servicio es SIEMPRE el `nodeId`,
        //    que es lo unico que el motor entiende.
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

    it('5.3 deberia marcar como leido un mensaje que NO es una orden', async () => {
      // 1. Arrange 📐: un buzon recibe correo que no son ordenes.
      const { service, client, executions } = buildHarness();
      simpleParser.mockResolvedValue(inboundMessage('Re: dudas del boletin'));

      // 2. Act ⚙️
      await service.processInbox();

      // 3. Assert 🎯
      expect(executions.resumeExecution).not.toHaveBeenCalled();
      expect(client.messageFlagsAdd).toHaveBeenCalledTimes(1);
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
});
