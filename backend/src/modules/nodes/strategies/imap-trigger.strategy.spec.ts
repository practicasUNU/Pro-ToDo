import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import {
  ImapTriggerConfigDto,
  resolveImapConfig,
} from '@modules/nodes/dto/imap-trigger-config.dto';
import { ALLOWED_NAMESPACES } from '@modules/templates/templates.service';
import { createMockStatePayloadContext } from '@test/factories/state-payload-context.factory';

import {
  ImapTriggerStrategy,
  NO_MESSAGES_STATUS,
} from './imap-trigger.strategy';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type { ParsedMail } from 'mailparser';

// Cero red: `testing-standards.md` §2 prohibe llamadas reales a IMAP. Ambos
// dobles se declaran antes de importar la estrategia (jest.mock se eleva).
jest.mock('imapflow');
jest.mock('mailparser');

/* eslint-disable @typescript-eslint/no-require-imports */
const { ImapFlow } = require('imapflow') as {
  ImapFlow: jest.Mock;
};
const { simpleParser } = require('mailparser') as {
  simpleParser: jest.Mock;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const OUTPUT_NAMESPACE = 'raw_email';
const PASSWORD_ENV_KEY = 'IMAP_PASSWORD';
const IMAP_PASSWORD = 'clave-de-buzon-solo-para-pruebas';
const MESSAGE_UID = 42;

/** `params` validos del nodo; cada prueba sobrescribe lo que le concierne. */
const buildParams = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  host: 'imap.unuware.com',
  port: 993,
  secure: true,
  user: 'notiweb@unuware.com',
  passwordEnvKey: PASSWORD_ENV_KEY,
  mailbox: 'INBOX',
  outputNamespace: OUTPUT_NAMESPACE,
  markAsRead: true,
  ...overrides,
});

/** Correo parseado por mailparser; solo los campos que el nodo proyecta. */
const buildParsedMail = (overrides: Partial<ParsedMail> = {}): ParsedMail =>
  ({
    messageId: '<abc-123@unuware.com>',
    from: {
      value: [{ address: 'prensa@unuware.com', name: 'Prensa' }],
      html: '<span>Prensa</span>',
      text: 'Prensa <prensa@unuware.com>',
    },
    subject: 'Innovacion en Madrid',
    date: new Date('2026-03-01T10:30:00.000Z'),
    html: '<h1>Innovacion</h1>',
    text: 'Innovacion en texto plano',
    textAsHtml: '<p>Innovacion en texto plano</p>',
    ...overrides,
  }) as ParsedMail;

/** Doble del cliente IMAP con las cinco operaciones que el nodo usa. */
interface ImapClientDouble {
  connect: jest.Mock;
  getMailboxLock: jest.Mock;
  search: jest.Mock;
  download: jest.Mock;
  messageFlagsAdd: jest.Mock;
  logout: jest.Mock;
  on: jest.Mock;
  release: jest.Mock;
}

const buildClient = (
  overrides: Partial<Record<keyof ImapClientDouble, jest.Mock>> = {},
): ImapClientDouble => {
  const release = jest.fn();

  return {
    connect: jest.fn().mockResolvedValue(undefined),
    getMailboxLock: jest.fn().mockResolvedValue({ path: 'INBOX', release }),
    search: jest.fn().mockResolvedValue([7, MESSAGE_UID, 12]),
    download: jest.fn().mockResolvedValue({ meta: {}, content: 'stream-mime' }),
    messageFlagsAdd: jest.fn().mockResolvedValue(true),
    logout: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    release,
    ...overrides,
  };
};

/** Inscribe el doble como valor de retorno del constructor de ImapFlow. */
const useClient = (client: ImapClientDouble): void => {
  ImapFlow.mockImplementation(() => client);
};

/**
 * Instancia la estrategia con un `ConfigService` doblado.
 *
 * Se mockea y no se usa el real sembrado porque `ConfigService.get()` da
 * prioridad a `process.env` sobre su objeto interno: una variable `IMAP_PASSWORD`
 * presente en la maquina que ejecuta la suite haria pasar la prueba negativa por
 * el motivo equivocado.
 */
const buildStrategy = (
  env: Record<string, string> = { [PASSWORD_ENV_KEY]: IMAP_PASSWORD },
): { strategy: ImapTriggerStrategy; get: jest.Mock } => {
  const get = jest.fn((key: string) => env[key]);
  const configService = { get } as unknown as ConfigService;

  return { strategy: new ImapTriggerStrategy(configService), get };
};

const buildContext = (): StatePayloadContext =>
  createMockStatePayloadContext({ currentStep: 'trigger_imap' });

describe('ImapTriggerStrategy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    simpleParser.mockResolvedValue(buildParsedMail());
    useClient(buildClient());
  });

  it('0.1 deberia declararse como el nodo TRIGGER_IMAP', () => {
    // 1. Arrange & 2. Act
    const { strategy } = buildStrategy();

    // 3. Assert: la factoria indexa por este valor.
    expect(strategy.nodeType).toBe(NodeType.TRIGGER_IMAP);
  });

  describe('1. Extraccion del correo UNSEEN', () => {
    it('1.1 deberia exponer las cinco claves deterministas del correo', async () => {
      // 1. Arrange
      const { strategy } = buildStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), buildParams());

      // 3. Assert
      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        message_id: '<abc-123@unuware.com>',
        from: 'prensa@unuware.com',
        subject: 'Innovacion en Madrid',
        text: 'Innovacion en texto plano',
        date: '2026-03-01T10:30:00.000Z',
      });
    });

    it('1.2 deberia tomar el UID mas alto de los mensajes sin leer', async () => {
      // 1. Arrange
      const client = buildClient({
        search: jest.fn().mockResolvedValue([7, MESSAGE_UID, 12]),
      });
      useClient(client);
      const { strategy } = buildStrategy();

      // 2. Act
      await strategy.execute(buildContext(), buildParams());

      // 3. Assert: 42 es el mas reciente, no el ultimo del arreglo.
      expect(client.search).toHaveBeenCalledWith(
        { seen: false },
        { uid: true },
      );
      expect(client.download).toHaveBeenCalledWith(
        String(MESSAGE_UID),
        undefined,
        { uid: true },
      );
    });

    it('1.3 no deberia propagar el HTML del correo bajo ninguna clave', async () => {
      // 1. Arrange: un MIME con marcado en las tres variantes de mailparser.
      simpleParser.mockResolvedValue(
        buildParsedMail({
          html: '<h1 style="color:red">Innovacion</h1>',
          textAsHtml: '<p>Innovacion en texto plano</p>',
        }),
      );
      const { strategy } = buildStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), buildParams());

      // 3. Assert: el cuerpo viaja solo como texto plano. El marcado final lo
      //    aporta la plantilla del gestor, no el correo de origen.
      expect(Object.keys(result.data ?? {})).toEqual([
        'message_id',
        'from',
        'subject',
        'text',
        'date',
      ]);
      expect(JSON.stringify(result.data)).not.toContain('<h1');
      expect(JSON.stringify(result.data)).not.toContain('<p>');
    });

    it('1.4 deberia dejar text vacio en un correo solo-HTML, sin parte text/plain', async () => {
      // 1. Arrange
      simpleParser.mockResolvedValue(
        buildParsedMail({ text: undefined, textAsHtml: undefined }),
      );
      const { strategy } = buildStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), buildParams());

      // 3. Assert: derivar texto del marcado seria sanitizar, y eso es
      //    competencia de PARSER_PRE_IA. El nodo no transforma nada.
      expect(result.success).toBe(true);
      expect(result.data?.text).toBe('');
    });

    it('1.5 deberia devolver cadenas vacias y nunca undefined en un correo sin cuerpo', async () => {
      // 1. Arrange: MIME minimo, sin remitente, asunto, fecha ni cuerpo.
      simpleParser.mockResolvedValue({});
      const { strategy } = buildStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), buildParams());

      // 3. Assert: toda clave presente y serializable por `structuredClone`.
      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        message_id: '',
        from: '',
        subject: '',
        text: '',
        date: '',
      });
      for (const value of Object.values(result.data ?? {})) {
        expect(typeof value).toBe('string');
      }
    });

    it('1.6 deberia usar el nombre formateado cuando el remitente no trae direccion', async () => {
      // 1. Arrange
      simpleParser.mockResolvedValue(
        buildParsedMail({
          from: {
            value: [{ name: 'Prensa' }],
            html: '',
            text: 'Prensa',
          },
        }),
      );
      const { strategy } = buildStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), buildParams());

      // 3. Assert
      expect(result.data?.from).toBe('Prensa');
    });

    it('1.7 deberia marcar \\Seen solo cuando markAsRead es true', async () => {
      // 1. Arrange
      const marking = buildClient();
      useClient(marking);
      const { strategy } = buildStrategy();

      // 2. Act
      await strategy.execute(buildContext(), buildParams({ markAsRead: true }));

      // 3. Assert
      expect(marking.messageFlagsAdd).toHaveBeenCalledWith(
        String(MESSAGE_UID),
        ['\\Seen'],
        { uid: true },
      );

      // 1. Arrange (segunda mitad): mismo flujo con la bandera desactivada.
      const untouched = buildClient();
      useClient(untouched);

      // 2. Act
      await strategy.execute(
        buildContext(),
        buildParams({ markAsRead: false }),
      );

      // 3. Assert
      expect(untouched.messageFlagsAdd).not.toHaveBeenCalled();
    });

    it('1.8 deberia marcar \\Seen despues de parsear, nunca antes', async () => {
      // 1. Arrange: el parseo revienta con un MIME corrupto.
      const client = buildClient();
      useClient(client);
      simpleParser.mockRejectedValue(new Error('MIME corrupto'));
      const { strategy } = buildStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), buildParams());

      // 3. Assert: el correo NO queda marcado, o se perderia para siempre.
      expect(result.success).toBe(false);
      expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    });
  });

  describe('1bis. Filtros de disparo (SEARCH)', () => {
    /**
     * Se asevera sobre `client.search` y no sobre el correo devuelto porque el
     * filtrado lo hace el SERVIDOR: filtrar en el cliente obligaria a descargar
     * el buzon entero para descartarlo, que es justo lo que IMAP SEARCH evita.
     */
    it('1bis.1 deberia filtrar por remitente cuando llega fromFilter', async () => {
      // 1. Arrange
      const { strategy } = buildStrategy();
      const client = buildClient();
      useClient(client);
      simpleParser.mockResolvedValue(buildParsedMail());

      // 2. Act
      await strategy.execute(
        buildContext(),
        buildParams({ fromFilter: 'redaccion@noticias.es' }),
      );

      // 3. Assert
      expect(client.search).toHaveBeenCalledWith(
        { seen: false, from: 'redaccion@noticias.es' },
        { uid: true },
      );
    });

    it('1bis.2 deberia filtrar por asunto cuando llega subjectFilter', async () => {
      // 1. Arrange
      const { strategy } = buildStrategy();
      const client = buildClient();
      useClient(client);
      simpleParser.mockResolvedValue(buildParsedMail());

      // 2. Act
      await strategy.execute(
        buildContext(),
        buildParams({ subjectFilter: 'Notiweb' }),
      );

      // 3. Assert
      expect(client.search).toHaveBeenCalledWith(
        { seen: false, subject: 'Notiweb' },
        { uid: true },
      );
    });

    it('1bis.3 deberia combinar los tres criterios con AND', async () => {
      // 1. Arrange
      const { strategy } = buildStrategy();
      const client = buildClient();
      useClient(client);
      simpleParser.mockResolvedValue(buildParsedMail());

      // 2. Act
      await strategy.execute(
        buildContext(),
        buildParams({
          unreadOnly: true,
          fromFilter: 'redaccion@noticias.es',
          subjectFilter: 'Notiweb',
        }),
      );

      // 3. Assert
      expect(client.search).toHaveBeenCalledWith(
        {
          seen: false,
          from: 'redaccion@noticias.es',
          subject: 'Notiweb',
        },
        { uid: true },
      );
    });

    it('1bis.4 deberia pedir el buzon entero con unreadOnly false y sin filtros', async () => {
      // 1. Arrange
      const { strategy } = buildStrategy();
      const client = buildClient();
      useClient(client);
      simpleParser.mockResolvedValue(buildParsedMail());

      // 2. Act
      await strategy.execute(buildContext(), buildParams({ unreadOnly: false }));

      // 3. Assert: `{}` seria una sentencia SEARCH invalida (el protocolo exige
      // al menos un criterio); `all` es la forma explicita de pedirlo todo.
      expect(client.search).toHaveBeenCalledWith({ all: true }, { uid: true });
    });

    it('1bis.5 deberia omitir el criterio seen cuando unreadOnly es false pero hay filtros', async () => {
      // 1. Arrange
      const { strategy } = buildStrategy();
      const client = buildClient();
      useClient(client);
      simpleParser.mockResolvedValue(buildParsedMail());

      // 2. Act
      await strategy.execute(
        buildContext(),
        buildParams({ unreadOnly: false, fromFilter: 'redaccion@noticias.es' }),
      );

      // 3. Assert
      expect(client.search).toHaveBeenCalledWith(
        { from: 'redaccion@noticias.es' },
        { uid: true },
      );
    });

    it('1bis.6 deberia rechazar un filtro vacio como GRAVE sin abrir conexion', async () => {
      // 1. Arrange
      const { strategy } = buildStrategy();
      const client = buildClient();
      useClient(client);

      // 2. Act
      const result = await strategy.execute(
        buildContext(),
        buildParams({ fromFilter: '' }),
      );

      // 3. Assert: una cadena vacia no es "sin filtro"; en IMAP SEARCH seria un
      // criterio que casa con todo. Quien no quiera filtrar, omite el campo.
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.missingFields).toContain('fromFilter');
      expect(client.connect).not.toHaveBeenCalled();
    });
  });

  describe('2. Buzon sin mensajes nuevos', () => {
    it('2.1 deberia devolver exito con NO_MESSAGES_FOUND y sin datos residuales', async () => {
      // 1. Arrange
      const client = buildClient({ search: jest.fn().mockResolvedValue([]) });
      useClient(client);
      const { strategy } = buildStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), buildParams());

      // 3. Assert: exito, porque un buzon vacio es el caso NORMAL del sondeo.
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ status: NO_MESSAGES_STATUS });
      expect(client.download).not.toHaveBeenCalled();
      expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    });

    it('2.2 deberia tratar el false de search como buzon vacio', async () => {
      // 1. Arrange: imapflow devuelve `false`, no un arreglo, si no hay UIDs.
      useClient(buildClient({ search: jest.fn().mockResolvedValue(false) }));
      const { strategy } = buildStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), buildParams());

      // 3. Assert
      expect(result.data).toEqual({ status: NO_MESSAGES_STATUS });
    });
  });

  describe('3. Resolucion del secreto (modelo hibrido)', () => {
    it('3.1 deberia fallar GRAVE sin conectar cuando la variable no existe', async () => {
      // 1. Arrange: entorno sin la clave referenciada.
      const client = buildClient();
      useClient(client);
      const { strategy } = buildStrategy({});

      // 2. Act
      const result = await strategy.execute(buildContext(), buildParams());

      // 3. Assert: guarda temprana; no se abre ningun socket.
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.missingFields).toContain(PASSWORD_ENV_KEY);
      expect(client.connect).not.toHaveBeenCalled();
      expect(ImapFlow).not.toHaveBeenCalled();
    });

    it('3.2 deberia fallar GRAVE cuando la variable existe pero esta vacia', async () => {
      // 1. Arrange
      const { strategy } = buildStrategy({ [PASSWORD_ENV_KEY]: '' });

      // 2. Act
      const result = await strategy.execute(buildContext(), buildParams());

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(ImapFlow).not.toHaveBeenCalled();
    });

    it('3.3 deberia leer la clave declarada en passwordEnvKey y no una fija', async () => {
      // 1. Arrange
      const { strategy, get } = buildStrategy({
        IMAP_NOTIWEB_PASSWORD: 'otra-clave',
      });

      // 2. Act
      const result = await strategy.execute(
        buildContext(),
        buildParams({ passwordEnvKey: 'IMAP_NOTIWEB_PASSWORD' }),
      );

      // 3. Assert
      expect(result.success).toBe(true);
      expect(get).toHaveBeenCalledWith('IMAP_NOTIWEB_PASSWORD');
    });

    it('3.4 deberia rechazar una passwordEnvKey que apunte a otro secreto', async () => {
      // 1. Arrange: intento de exfiltracion via el pipeline_schema.
      const { strategy, get } = buildStrategy({ JWT_SECRET: 'no-debe-salir' });

      // 2. Act
      const result = await strategy.execute(
        buildContext(),
        buildParams({ passwordEnvKey: 'JWT_SECRET' }),
      );

      // 3. Assert: se rechaza en la validacion, ANTES de tocar el entorno.
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.missingFields).toContain('passwordEnvKey');
      expect(get).not.toHaveBeenCalled();
      expect(ImapFlow).not.toHaveBeenCalled();
    });
  });

  describe('4. Configuracion invalida', () => {
    it('4.1 deberia fallar GRAVE sin conectar cuando falta el host', async () => {
      // 1. Arrange
      const params = buildParams();
      delete params.host;
      const { strategy } = buildStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), params);

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.missingFields).toContain('host');
      expect(ImapFlow).not.toHaveBeenCalled();
    });

    it('4.2 deberia rechazar un params que traiga la contrasena en claro', async () => {
      // 1. Arrange: `forbidNonWhitelisted` convierte la ausencia del campo en
      //    una barrera activa, no en una convencion.
      const { strategy } = buildStrategy();

      // 2. Act
      const result = await strategy.execute(
        buildContext(),
        buildParams({ password: 'secreto-en-la-columna-jsonb' }),
      );

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.missingFields).toContain('password');
    });

    it('4.3 deberia rechazar un pollIntervalMs por debajo del minimo', async () => {
      // 1. Arrange
      const { strategy } = buildStrategy();

      // 2. Act
      const result = await strategy.execute(
        buildContext(),
        buildParams({ pollIntervalMs: 1000 }),
      );

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.missingFields).toContain('pollIntervalMs');
    });
  });

  describe('5. Fallos de red y autenticacion', () => {
    it('5.1 deberia devolver GRAVE con stackTrace ante credenciales invalidas', async () => {
      // 1. Arrange
      const failure = new Error('Invalid credentials (AUTHENTICATIONFAILED)');
      useClient(buildClient({ connect: jest.fn().mockRejectedValue(failure) }));
      const { strategy } = buildStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), buildParams());

      // 3. Assert: GRAVE y no URGENTE, para que el motor pueda reintentarlo.
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.message).toContain('AUTHENTICATIONFAILED');
      expect(result.error?.stackTrace).toBeDefined();
    });

    it('5.2 deberia devolver GRAVE ante un timeout de socket', async () => {
      // 1. Arrange
      useClient(
        buildClient({
          getMailboxLock: jest
            .fn()
            .mockRejectedValue(new Error('Socket timeout')),
        }),
      );
      const { strategy } = buildStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), buildParams());

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
    });

    it('5.3 deberia registrar un oyente de error en el cliente IMAP', async () => {
      // 1. Arrange
      const client = buildClient();
      useClient(client);
      const { strategy } = buildStrategy();

      // 2. Act
      await strategy.execute(buildContext(), buildParams());

      // 3. Assert: sin oyente, un evento 'error' del EventEmitter tumbaria el
      //    proceso de Node entero.
      expect(client.on).toHaveBeenCalledWith('error', expect.any(Function));
    });
  });

  describe('6. Cierre de la conexion', () => {
    it('6.1 deberia liberar el bloqueo y cerrar sesion tras un exito', async () => {
      // 1. Arrange
      const client = buildClient();
      useClient(client);
      const { strategy } = buildStrategy();

      // 2. Act
      await strategy.execute(buildContext(), buildParams());

      // 3. Assert
      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.logout).toHaveBeenCalledTimes(1);
    });

    it('6.2 deberia cerrar sesion aunque el parseo lance', async () => {
      // 1. Arrange
      const client = buildClient();
      useClient(client);
      simpleParser.mockRejectedValue(new Error('MIME corrupto'));
      const { strategy } = buildStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), buildParams());

      // 3. Assert: el bloque `finally` corre igual.
      expect(result.success).toBe(false);
      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.logout).toHaveBeenCalledTimes(1);
    });

    it('6.3 no deberia enmascarar el error real si falla el cierre', async () => {
      // 1. Arrange: el fallo de negocio ocurre y ADEMAS logout revienta.
      const client = buildClient({
        search: jest.fn().mockRejectedValue(new Error('Conexion perdida')),
        logout: jest.fn().mockRejectedValue(new Error('Socket ya cerrado')),
      });
      useClient(client);
      const { strategy } = buildStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), buildParams());

      // 3. Assert: prevalece el error de negocio, no el del cierre.
      expect(result.error?.message).toContain('Conexion perdida');
    });
  });

  describe('7. Inmutabilidad del contexto', () => {
    it('7.1 no deberia escribir en el contexto: eso lo hace el motor', async () => {
      // 1. Arrange
      const context = buildContext();
      const before = context.getAllContext();
      const { strategy } = buildStrategy();

      // 2. Act
      const result = await strategy.execute(context, buildParams());

      // 3. Assert: el correo viaja en `data` y el contexto queda intacto;
      //    `FsmEngineService` lo depositara en el `outputNamespace` del nodo.
      expect(result.success).toBe(true);
      expect(context.getAllContext()).toEqual(before);
      expect(context.getNamespace(OUTPUT_NAMESPACE)).toBeUndefined();
    });
  });

  describe('8. Namespace de salida', () => {
    it('8.1 deberia usar raw_email como namespace por defecto', () => {
      // 1. Arrange & 2. Act
      const params = buildParams();
      delete params.outputNamespace;
      const config = resolveImapConfig(
        plainToInstance(ImapTriggerConfigDto, params),
      );

      // 3. Assert: `raw_email` esta en ALLOWED_NAMESPACES, asi que una plantilla
      //    puede interpolar `{{raw_email.subject}}` sin tocar el gestor.
      expect(config.outputNamespace).toBe('raw_email');
      expect(ALLOWED_NAMESPACES).toContain(config.outputNamespace);
    });

    it('8.2 deberia rechazar un namespace fuera del patron snake_case', async () => {
      // 1. Arrange
      const { strategy } = buildStrategy();

      // 2. Act
      const result = await strategy.execute(
        buildContext(),
        buildParams({ outputNamespace: 'Raw-Email' }),
      );

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.missingFields).toContain('outputNamespace');
    });
  });
});
