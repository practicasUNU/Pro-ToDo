import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { createMockStatePayloadContext } from '@test/factories/state-payload-context.factory';

import {
  DEFAULT_ALERT_SUBJECT,
  ERR_SMTP_CONFIG,
  ERR_SMTP_SEND_FAILURE,
  SAFE_FALLBACK_SUBJECT,
  SmtpAlertStrategy,
} from './smtp-alert.strategy';

import type {
  NodeMailMessage,
  SmtpNodeMailerService,
} from '@common/services/smtp-node-mailer.service';
import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';

/** Doble del transporte, acotado al unico metodo que la estrategia invoca. */
type MailerMock = jest.Mocked<Pick<SmtpNodeMailerService, 'sendNodeAlert'>>;

const RECIPIENT = 'guardia@unuware.com';

/** `workflowId` que la factoria de contexto asigna por defecto. */
const FLOW_ID = 'flow-00000000-0000-4000-8000-000000000000';

const buildMailer = (overrides: Partial<MailerMock> = {}): MailerMock => ({
  sendNodeAlert: jest.fn().mockResolvedValue({
    messageId: '<aviso-1@unuware.com>',
    accepted: [RECIPIENT],
    rejected: [],
  }),
  ...overrides,
});

const buildStrategy = (mailer: MailerMock = buildMailer()): SmtpAlertStrategy =>
  new SmtpAlertStrategy(mailer as unknown as SmtpNodeMailerService);

/** Silencia las trazas del nodo: la suite asevera sobre el correo, no sobre el log. */
const muteLogger = (strategy: SmtpAlertStrategy): void => {
  jest.spyOn(strategy['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(strategy['logger'], 'warn').mockImplementation(() => undefined);
};

/** El mensaje que recibio el transporte, tipado para no indexar a ciegas. */
const sentMessage = (mailer: MailerMock): NodeMailMessage => {
  const [message] = mailer.sendNodeAlert.mock.calls[0] ?? [];

  if (message === undefined) {
    throw new Error('El transporte no recibio ningun mensaje.');
  }

  return message;
};

/**
 * Contexto tal y como lo deja el motor tras desviar por `onErrorStep`.
 *
 * Es el escenario que motiva el nodo, asi que es el defecto de la suite: el
 * namespace `error_context` ya sembrado con los metadatos del fallo.
 */
const buildContext = (
  namespaces: Record<string, Record<string, unknown>> = {
    error_context: {
      failed_node_id: 'nodo_parser',
      failed_node_type: 'PARSER_PRE_IA',
      error_code: 'ERR_PARSER_UNEXTRACTABLE_MEDIA',
      error_level: 'GRAVE',
      error_message: 'El correo solo trae un PDF escaneado',
      partial_data: { attachment_count: 1 },
    },
  },
): StatePayloadContext =>
  createMockStatePayloadContext({
    currentStep: 'nodo_alerta',
    namespaces,
  });

/** `params` completos y validos; cada prueba ajusta lo suyo. */
const buildParams = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  to: [RECIPIENT],
  subject: 'Flujo detenido en {{error_context.failed_node_id}}',
  ...overrides,
});

describe('SmtpAlertStrategy', () => {
  it('0.1 deberia declararse como el nodo DESTINO_SMTP', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const strategy = buildStrategy();

    // 3. Assert 🎯
    expect(strategy.nodeType).toBe(NodeType.DESTINO_SMTP);
  });

  describe('1. Envio correcto', () => {
    it('1.1 deberia interpolar el asunto antes de entregarlo', async () => {
      // 1. Arrange 📐
      const mailer = buildMailer();
      const strategy = buildStrategy(mailer);
      muteLogger(strategy);

      // 2. Act ⚙️
      await strategy.execute(buildContext(), buildParams());

      // 3. Assert 🎯: el transporte recibe texto resuelto, nunca un marcador.
      //    Un aviso que llegue con `{{error_context.failed_node_id}}` literal es
      //    peor que ninguno: parece un correo roto del sistema.
      expect(mailer.sendNodeAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          to: [RECIPIENT],
          subject: 'Flujo detenido en nodo_parser',
        }),
      );
    });

    it('1.2 deberia publicar el acuse del servidor en su namespace', async () => {
      // 1. Arrange 📐
      const strategy = buildStrategy(
        buildMailer({
          sendNodeAlert: jest.fn().mockResolvedValue({
            messageId: '<aviso-7@unuware.com>',
            accepted: [RECIPIENT],
            rejected: ['buzon-lleno@unuware.com'],
          }),
        }),
      );
      muteLogger(strategy);

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), buildParams());

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        sent_to: [RECIPIENT],
        subject: 'Flujo detenido en nodo_parser',
        message_id: '<aviso-7@unuware.com>',
        accepted_count: 1,
        rejected_count: 1,
      });
      expect(typeof result.data?.sent_at).toBe('string');
    });

    it('1.3 deberia omitir replyTo cuando el nodo no lo declara', async () => {
      // 1. Arrange 📐: pasar `replyTo: undefined` haria que nodemailer recibiera
      //    la clave igualmente, y algunos servidores la rechazan vacia.
      const mailer = buildMailer();
      const strategy = buildStrategy(mailer);
      muteLogger(strategy);

      // 2. Act ⚙️
      await strategy.execute(buildContext(), buildParams());

      // 3. Assert 🎯
      expect(sentMessage(mailer)).not.toHaveProperty('replyTo');
    });

    it('1.4 deberia entregar SIEMPRE las dos versiones del aviso', async () => {
      // 1. Arrange 📐
      const mailer = buildMailer();
      const strategy = buildStrategy(mailer);
      muteLogger(strategy);

      // 2. Act ⚙️
      await strategy.execute(buildContext(), buildParams());

      // 3. Assert 🎯: el texto plano no es cortesia con clientes antiguos. Es lo
      //    que hace legible el aviso en un reloj o en un cliente con el marcado
      //    bloqueado, que es configuracion corriente en correo corporativo.
      const message = sentMessage(mailer);

      expect(message.html).toContain('<table');
      expect(message.text).not.toContain('<table');
      expect(message.text).toContain('PROTO-DO');
    });
  });

  describe('2. Fallos GRAVE', () => {
    it('2.1 deberia rechazar una configuracion con forma invalida', async () => {
      // 1. Arrange 📐
      const mailer = buildMailer();
      const strategy = buildStrategy(mailer);

      // 2. Act ⚙️
      const result = await strategy.execute(
        buildContext(),
        buildParams({ to: ['esto-no-es-un-correo'] }),
      );

      // 3. Assert 🎯: se corta ANTES de abrir conexion.
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_SMTP_CONFIG);
      expect(result.error?.level).toBe('GRAVE');
      expect(mailer.sendNodeAlert).not.toHaveBeenCalled();
    });

    it('2.2 deberia rechazar params sin destinatario aunque su forma sea valida', async () => {
      // 1. Arrange 📐: el DTO admite la ausencia para que una plantilla de flujo
      //    pueda contener este nodo. La completitud es otra pregunta, y desde
      //    que el asunto tiene defecto y el cuerpo lo compone el sistema, `to`
      //    es lo unico que el sistema no puede adivinar.
      const mailer = buildMailer();
      const strategy = buildStrategy(mailer);

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {});

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_SMTP_CONFIG);
      expect(result.error?.missingFields).toEqual(['to']);
      expect(mailer.sendNodeAlert).not.toHaveBeenCalled();
    });

    it('2.3 deberia rechazar una nota mas larga que el tope', async () => {
      // 1. Arrange 📐
      const mailer = buildMailer();
      const strategy = buildStrategy(mailer);

      // 2. Act ⚙️
      const result = await strategy.execute(
        buildContext(),
        buildParams({ customMessage: 'x'.repeat(2_001) }),
      );

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_SMTP_CONFIG);
      expect(result.error?.missingFields).toEqual(['customMessage']);
    });

    it('2.4 deberia traducir un fallo del transporte sin dejarlo escapar', async () => {
      // 1. Arrange 📐
      const strategy = buildStrategy(
        buildMailer({
          sendNodeAlert: jest
            .fn()
            .mockRejectedValue(new Error('ECONNREFUSED smtp.example.com:587')),
        }),
      );
      muteLogger(strategy);

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), buildParams());

      // 3. Assert 🎯: GRAVE para que el motor lo reintente con backoff. Un SMTP
      //    que no responde es el caso de manual para insistir.
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_SMTP_SEND_FAILURE);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.message).toContain('ECONNREFUSED');
    });
  });

  describe('3. Inmutabilidad del contexto', () => {
    it('3.1 no deberia escribir en el contexto: eso es del motor', async () => {
      // 1. Arrange 📐
      const context = buildContext();
      const before = context.getAllContext();
      const strategy = buildStrategy();
      muteLogger(strategy);

      // 2. Act ⚙️
      await strategy.execute(context, buildParams());

      // 3. Assert 🎯: el nodo devuelve `data` y es `FsmEngineService` quien la
      //    deposita en el `outputNamespace`.
      expect(context.getAllContext()).toEqual(before);
    });
  });

  describe('4. Namespaces requeridos', () => {
    it('4.1 deberia derivarlos del asunto, sin repetirlos', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const required = buildStrategy().getRequiredNamespaces(
        buildParams({
          subject:
            '{{error_context.failed_node_id}} sobre {{parsed_email.subject}} ({{error_context.error_code}})',
        }),
      );

      // 3. Assert 🎯: un asunto suele citar `error_context` mas de una vez, y
      //    declararlo dos veces solo ensuciaria el diagnostico del motor.
      expect([...required].sort()).toEqual(['error_context', 'parsed_email']);
    });

    it('4.2 NO deberia mirar los destinatarios ni la nota', () => {
      // 1. Arrange 📐: `to`, `cc` y `replyTo` son direcciones literales, no
      //    plantillas. Que lo sigan siendo es lo que impide que quien escribe al
      //    buzon del flujo elija a quien avisa el sistema. `customMessage`
      //    tampoco se interpola.
      const required = buildStrategy().getRequiredNamespaces({
        to: ['{{error_context.error_message}}'],
        subject: 'Fijo',
        customMessage: '{{parsed_email.subject}}',
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(required).toEqual([]);
    });

    it('4.3 no deberia exigir nada cuando el nodo no declara asunto', () => {
      // 1. Arrange 📐 + 2. Act ⚙️: acabara usando DEFAULT_ALERT_SUBJECT, que cita
      //    `trigger`. Declararlo seria inutil —el motor excluye ese namespace de
      //    la comprobacion— y enganoso, porque el defecto tiene respaldo.
      const required = buildStrategy().getRequiredNamespaces({
        to: [RECIPIENT],
      });

      // 3. Assert 🎯
      expect(required).toEqual([]);
    });
  });

  describe('5. Completitud para activar', () => {
    it('5.1 deberia nombrar solo el destinatario', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const missing = buildStrategy().getIncompleteParams({});

      // 3. Assert 🎯
      expect(missing).toEqual(['to']);
    });

    it('5.2 no deberia declarar nada incompleto con un destinatario', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const missing = buildStrategy().getIncompleteParams({ to: [RECIPIENT] });

      // 3. Assert 🎯
      expect(missing).toEqual([]);
    });

    it('5.3 no deberia exigir el asunto: tiene defecto', () => {
      // 1. Arrange 📐 + 2. Act ⚙️: bloquear el asistente por un campo que el
      //    backend sabe rellenar seria un Poka-Yoke al reves.
      const missing = buildStrategy().getIncompleteParams({
        to: [RECIPIENT],
        subject: '   ',
      });

      // 3. Assert 🎯
      expect(missing).toEqual([]);
    });

    it('5.4 deberia tratar un arreglo de destinatarios vacio como ausencia', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const missing = buildStrategy().getIncompleteParams({ to: [] });

      // 3. Assert 🎯
      expect(missing).toEqual(['to']);
    });
  });

  describe('6. Inventario de salida (outputFields)', () => {
    it('6.1 deberia coincidir con las claves que emite execute', async () => {
      // 1. Arrange 📐
      const strategy = buildStrategy();
      muteLogger(strategy);

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), buildParams());

      // 3. Assert 🎯: el inventario es lo que el asistente ofrece en su selector
      //    cerrado. Si promete una clave que `execute` no escribe, el operador
      //    compone un `{{smtp_result.campo}}` que jamas resolvera.
      expect(strategy.outputFields.map((field) => field.name)).toEqual(
        Object.keys(result.data ?? {}),
      );
    });
  });

  describe('7. Asunto por defecto y respaldo', () => {
    it('7.1 deberia aplicar el defecto cuando el nodo no declara asunto', async () => {
      // 1. Arrange 📐: el defecto cita `{{trigger.flow_name}}`, que este contexto
      //    SI resuelve.
      const mailer = buildMailer();
      const strategy = buildStrategy(mailer);
      muteLogger(strategy);

      // 2. Act ⚙️
      await strategy.execute(
        buildContext({ trigger: { flow_name: 'Notas de prensa' } }),
        { to: [RECIPIENT] },
      );

      // 3. Assert 🎯
      expect(sentMessage(mailer).subject).toBe(
        '[ALERTA PROTO-DO] Notificacion de incidencia en flujo Notas de prensa',
      );
    });

    it('7.2 deberia tratar un asunto en blanco como ausencia', async () => {
      // 1. Arrange 📐: borrar el campo desde la interfaz es una accion legitima,
      //    no un error de configuracion.
      const mailer = buildMailer();
      const strategy = buildStrategy(mailer);
      muteLogger(strategy);

      // 2. Act ⚙️
      const result = await strategy.execute(
        buildContext({ trigger: { flow_name: 'Notas de prensa' } }),
        { to: [RECIPIENT], subject: '   ' },
      );

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(sentMessage(mailer).subject).toContain('Notas de prensa');
    });

    it('7.3 deberia ENVIAR el aviso aunque el asunto no resuelva', async () => {
      // 1. Arrange 📐: es el caso corriente, porque `trigger` no lo siembra nadie
      //    en los dos caminos reales de ejecucion. Este nodo es la ultima via por
      //    la que una persona se entera de la incidencia: negarse a enviar por
      //    una errata en el asunto dejaria el fallo original sin testigo ademas
      //    de sin arreglar.
      const mailer = buildMailer();
      const strategy = buildStrategy(mailer);
      muteLogger(strategy);

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        to: [RECIPIENT],
      });

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(sentMessage(mailer).subject).toBe(SAFE_FALLBACK_SUBJECT);
      expect(mailer.sendNodeAlert).toHaveBeenCalledTimes(1);
    });

    it('7.4 deberia denunciar en la carta la variable que no resolvio', async () => {
      // 1. Arrange 📐: el diagnostico no se pierde, cambia de sitio. En vez de un
      //    flujo PAUSADO que nadie mira, la misconfiguracion llega impresa en el
      //    correo que la persona ya esta leyendo.
      const mailer = buildMailer();
      const strategy = buildStrategy(mailer);
      muteLogger(strategy);

      // 2. Act ⚙️
      await strategy.execute(
        buildContext(),
        buildParams({ subject: 'Fallo en {{error_context.inexistente}}' }),
      );

      // 3. Assert 🎯
      const message = sentMessage(mailer);

      expect(message.subject).toBe(SAFE_FALLBACK_SUBJECT);
      expect(message.html).toContain('error_context.inexistente');
      expect(message.text).toContain('error_context.inexistente');
    });

    it('7.5 deberia avisar en el log del respaldo aplicado', async () => {
      // 1. Arrange 📐
      const strategy = buildStrategy();
      jest.spyOn(strategy['logger'], 'log').mockImplementation(() => undefined);
      const warn = jest
        .spyOn(strategy['logger'], 'warn')
        .mockImplementation(() => undefined);

      // 2. Act ⚙️
      await strategy.execute(buildContext(), {
        to: [RECIPIENT],
        subject: 'Fallo en {{sin_namespace.campo}}',
      });

      // 3. Assert 🎯
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('sin_namespace.campo'),
      );
    });

    it('7.6 deberia conservar el marcador en el defecto exportado', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯: el frontend replica esta misma
      //    constante para pre-poblar el campo. Si divergen, el operador ve en el
      //    formulario un asunto distinto del que se envia al dejarlo vacio.
      expect(DEFAULT_ALERT_SUBJECT).toContain('{{trigger.flow_name}}');
    });
  });

  describe('8. Contenido de la carta', () => {
    it('8.1 deberia incrustar la nota del operador', async () => {
      // 1. Arrange 📐
      const mailer = buildMailer();
      const strategy = buildStrategy(mailer);
      muteLogger(strategy);

      // 2. Act ⚙️
      await strategy.execute(
        buildContext(),
        buildParams({ customMessage: 'Avisar al responsable de guardia.' }),
      );

      // 3. Assert 🎯
      const message = sentMessage(mailer);

      expect(message.html).toContain('Avisar al responsable de guardia.');
      expect(message.html).toContain('Nota del operador');
      expect(message.text).toContain('Avisar al responsable de guardia.');
    });

    it('8.2 deberia volcar el diagnostico que dejo el motor', async () => {
      // 1. Arrange 📐
      const mailer = buildMailer();
      const strategy = buildStrategy(mailer);
      muteLogger(strategy);

      // 2. Act ⚙️
      await strategy.execute(buildContext(), buildParams());

      // 3. Assert 🎯
      const { html } = sentMessage(mailer);

      expect(html).toContain('ERR_PARSER_UNEXTRACTABLE_MEDIA');
      expect(html).toContain('GRAVE');
      expect(html).toContain('nodo_parser');
      expect(html).toContain(FLOW_ID);
    });

    it('8.3 NO deberia escribir undefined sin error_context', async () => {
      // 1. Arrange 📐: el nodo puede colocarse en el camino feliz para confirmar
      //    una publicacion, y ahi el motor nunca siembra `error_context`.
      const mailer = buildMailer();
      const strategy = buildStrategy(mailer);
      muteLogger(strategy);

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext({}), {
        to: [RECIPIENT],
        subject: 'Publicacion completada',
      });

      // 3. Assert 🎯
      const message = sentMessage(mailer);

      expect(result.success).toBe(true);
      expect(message.html).not.toContain('undefined');
      expect(message.text).not.toContain('undefined');
      expect(message.html).not.toContain('Codigo de error');
    });

    it('8.4 deberia escapar el marcado que llega del correo entrante', async () => {
      // 1. Arrange 📐: `error_message` cita el asunto del correo original, que lo
      //    escribe cualquiera que sepa la direccion del buzon del flujo. Sin
      //    escapar, ese texto inyecta marcado en el buzon de quien esta de
      //    guardia.
      const mailer = buildMailer();
      const strategy = buildStrategy(mailer);
      muteLogger(strategy);

      // 2. Act ⚙️
      await strategy.execute(
        buildContext({
          error_context: {
            error_message: '<img src=x onerror="alert(1)">',
            partial_data: { subject: '<script>robar()</script>' },
          },
        }),
        { to: [RECIPIENT], subject: 'Fijo' },
      );

      // 3. Assert 🎯
      const { html } = sentMessage(mailer);

      expect(html).not.toContain('<img src=x');
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;img src=x');
      expect(html).toContain('&lt;script&gt;');
    });

    it('8.5 deberia escapar tambien la nota del operador', async () => {
      // 1. Arrange 📐: el operador es de confianza, pero el campo viaja en un
      //    `jsonb` que se puede escribir por SQL directo, y una plantilla de
      //    flujo compartida lo arrastra a otros despliegues.
      const mailer = buildMailer();
      const strategy = buildStrategy(mailer);
      muteLogger(strategy);

      // 2. Act ⚙️
      await strategy.execute(
        buildContext(),
        buildParams({ customMessage: '<b>urgente</b>' }),
      );

      // 3. Assert 🎯
      expect(sentMessage(mailer).html).toContain('&lt;b&gt;urgente&lt;/b&gt;');
    });
  });
});
