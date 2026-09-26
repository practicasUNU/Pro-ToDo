import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { createMockStatePayloadContext } from '@test/factories/state-payload-context.factory';

import {
  ERR_SMTP_CONFIG,
  ERR_SMTP_INTERPOLATION,
  ERR_SMTP_SEND_FAILURE,
  SmtpAlertStrategy,
} from './smtp-alert.strategy';

import type { SmtpNodeMailerService } from '@common/services/smtp-node-mailer.service';
import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';

/** Doble del transporte, acotado al unico metodo que la estrategia invoca. */
type MailerMock = jest.Mocked<Pick<SmtpNodeMailerService, 'sendNodeAlert'>>;

const RECIPIENT = 'guardia@unuware.com';

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
      error_code: 'ERR_PARSER_UNEXTRACTABLE_MEDIA',
      error_message: 'El correo solo trae un PDF escaneado',
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
  bodyTemplate: 'Motivo: {{error_context.error_message}}',
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
    it('1.1 deberia interpolar asunto y cuerpo antes de entregarlos', async () => {
      // 1. Arrange 📐
      const mailer = buildMailer();
      const strategy = buildStrategy(mailer);
      jest.spyOn(strategy['logger'], 'log').mockImplementation(() => undefined);

      // 2. Act ⚙️
      await strategy.execute(buildContext(), buildParams());

      // 3. Assert 🎯: el transporte recibe texto resuelto, nunca un marcador.
      //    Un aviso que llegue con `{{error_context.error_message}}` literal es
      //    peor que ninguno: parece un correo roto del sistema.
      expect(mailer.sendNodeAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          to: [RECIPIENT],
          subject: 'Flujo detenido en nodo_parser',
          text: 'Motivo: El correo solo trae un PDF escaneado',
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
      jest.spyOn(strategy['logger'], 'log').mockImplementation(() => undefined);

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
      jest.spyOn(strategy['logger'], 'log').mockImplementation(() => undefined);

      // 2. Act ⚙️
      await strategy.execute(buildContext(), buildParams());

      // 3. Assert 🎯
      expect(mailer.sendNodeAlert.mock.calls[0]?.[0]).not.toHaveProperty(
        'replyTo',
      );
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

    it('2.2 deberia rechazar params incompletos aunque su forma sea valida', async () => {
      // 1. Arrange 📐: el DTO admite la ausencia para que una plantilla de flujo
      //    pueda contener este nodo. La completitud es otra pregunta.
      const mailer = buildMailer();
      const strategy = buildStrategy(mailer);

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        to: [RECIPIENT],
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_SMTP_CONFIG);
      expect(result.error?.missingFields).toEqual(['subject', 'bodyTemplate']);
      expect(mailer.sendNodeAlert).not.toHaveBeenCalled();
    });

    it('2.3 deberia traducir un marcador sin resolver a un codigo propio', async () => {
      // 1. Arrange 📐: `getInterpolatedValue` LANZA, y dejar salir la excepcion
      //    la normalizaria el motor a URGENTE, que nunca se reintenta y que el
      //    operador no puede corregir desde el flujo PAUSADO.
      const mailer = buildMailer();
      const strategy = buildStrategy(mailer);

      // 2. Act ⚙️
      const result = await strategy.execute(
        buildContext(),
        buildParams({ bodyTemplate: 'Motivo: {{error_context.inexistente}}' }),
      );

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_SMTP_INTERPOLATION);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.missingFields).toEqual([
        'error_context.inexistente',
      ]);
      expect(mailer.sendNodeAlert).not.toHaveBeenCalled();
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
      jest.spyOn(strategy['logger'], 'log').mockImplementation(() => undefined);

      // 2. Act ⚙️
      await strategy.execute(context, buildParams());

      // 3. Assert 🎯: el nodo devuelve `data` y es `FsmEngineService` quien la
      //    deposita en el `outputNamespace`.
      expect(context.getAllContext()).toEqual(before);
    });
  });

  describe('4. Namespaces requeridos', () => {
    it('4.1 deberia derivarlos de las plantillas, sin repetirlos', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const required = buildStrategy().getRequiredNamespaces(
        buildParams({
          subject: 'Fallo en {{error_context.failed_node_id}}',
          bodyTemplate:
            '{{error_context.error_message}} sobre {{parsed_email.subject}}',
        }),
      );

      // 3. Assert 🎯: el asunto y el cuerpo suelen citar ambos `error_context`,
      //    y declararlo dos veces solo ensuciaria el diagnostico del motor.
      expect([...required].sort()).toEqual(['error_context', 'parsed_email']);
    });

    it('4.2 NO deberia mirar los destinatarios', () => {
      // 1. Arrange 📐: `to`, `cc` y `replyTo` son direcciones literales, no
      //    plantillas. Que lo sigan siendo es lo que impide que quien escribe al
      //    buzon del flujo elija a quien avisa el sistema.
      const required = buildStrategy().getRequiredNamespaces({
        to: ['{{error_context.error_message}}'],
        subject: 'Fijo',
        bodyTemplate: 'Fijo',
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(required).toEqual([]);
    });
  });

  describe('5. Completitud para activar', () => {
    it('5.1 deberia nombrar los tres params sin los que no hay aviso', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const missing = buildStrategy().getIncompleteParams({});

      // 3. Assert 🎯
      expect(missing).toEqual(['to', 'subject', 'bodyTemplate']);
    });

    it('5.2 no deberia declarar nada incompleto con los tres puestos', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const missing = buildStrategy().getIncompleteParams(buildParams());

      // 3. Assert 🎯
      expect(missing).toEqual([]);
    });

    it('5.3 deberia tratar una cadena de solo espacios como ausencia', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const missing = buildStrategy().getIncompleteParams(
        buildParams({ subject: '   ' }),
      );

      // 3. Assert 🎯
      expect(missing).toEqual(['subject']);
    });
  });

  describe('6. Inventario de salida (outputFields)', () => {
    it('6.1 deberia coincidir con las claves que emite execute', async () => {
      // 1. Arrange 📐
      const strategy = buildStrategy();
      jest.spyOn(strategy['logger'], 'log').mockImplementation(() => undefined);

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
});
