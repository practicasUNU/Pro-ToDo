import { InternalServerErrorException } from '@nestjs/common';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { createMockStatePayloadContext } from '@test/factories/state-payload-context.factory';

import {
  ERR_PAUSE_CONFIG,
  PROGRAMMED_PAUSE_REASON,
  PauseFlowStrategy,
} from './pause-flow.strategy';

import type { SmtpNodeMailerService } from '@common/services/smtp-node-mailer.service';

const RECIPIENT = 'operaciones@unuware.com';

/**
 * Transporte doble.
 *
 * Miembros `jest.Mock` en vez de `jest.Mocked<SmtpNodeMailerService>` por el
 * mismo motivo que en el spec del nodo de alerta: `expect(mailer.metodo)` sobre
 * un tipo con metodos de instancia dispara `@typescript-eslint/unbound-method`.
 */
interface MailerMock {
  sendNodeAlert: jest.Mock;
}

const buildMailer = (): MailerMock => ({
  sendNodeAlert: jest.fn().mockResolvedValue({
    messageId: 'msg-1',
    accepted: [RECIPIENT],
    rejected: [],
  }),
});

const buildStrategy = (
  mailer: MailerMock = buildMailer(),
): { strategy: PauseFlowStrategy; mailer: MailerMock } => ({
  strategy: new PauseFlowStrategy(mailer as unknown as SmtpNodeMailerService),
  mailer,
});

const buildContext = () =>
  createMockStatePayloadContext({
    currentStep: 'pausa_revision',
    namespaces: { trigger: { flow_name: 'Notiweb diario' } },
  });

describe('PauseFlowStrategy (nodo de pausa deliberada)', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('1. Senal de pausa', () => {
    it('1.1 deberia declarar el tipo de nodo PAUSA_FLOW', () => {
      // 1. Arrange 📐 & 2. Act ⚙️
      const { strategy } = buildStrategy();

      // 3. Assert 🎯
      expect(strategy.nodeType).toBe(NodeType.PAUSA_FLOW);
    });

    it('1.2 deberia pedir la pausa con un payload neutro y sin excepciones', async () => {
      // 1. Arrange 📐: configuracion minima. El nodo no necesita nada para
      //    hacer su trabajo, que es justo lo que lo distingue de un destino.
      const { strategy } = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {});

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.pause).toEqual({ reason: PROGRAMMED_PAUSE_REASON });
    });

    it('1.3 deberia publicar la senal tambien en `data`, para la trazabilidad', async () => {
      // 1. Arrange 📐: `pause` gobierna la transicion y `data` deja el motivo
      //    legible en el checkpoint. Las dos vias coexisten a proposito.
      const { strategy } = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {});

      // 3. Assert 🎯
      expect(result.data).toMatchObject({
        shouldPause: true,
        pauseReason: PROGRAMMED_PAUSE_REASON,
        pause_mode: 'IMMEDIATE',
        delayed_seconds: 0,
        message: 'Pausa programada de flujo',
      });
    });

    it('1.4 deberia conservar el mensaje que escribio el operador', async () => {
      // 1. Arrange 📐
      const { strategy } = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        customPauseMessage: 'A la espera del visto bueno de redaccion.',
      });

      // 3. Assert 🎯
      expect(result.data?.message).toBe(
        'A la espera del visto bueno de redaccion.',
      );
    });

    it('1.5 NO deberia declarar severidad ni codigo de error', async () => {
      // 1. Arrange 📐: una pausa deliberada no es una incidencia. Si colara un
      //    `error`, el motor escribiria alerta y el operador veria una caida.
      const { strategy } = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {});

      // 3. Assert 🎯
      expect(result.error).toBeUndefined();
      expect(result.halt).toBeUndefined();
    });
  });

  describe('2. Retardo antes de congelar', () => {
    it('2.1 NO deberia esperar nada cuando la pausa es inmediata', async () => {
      // 1. Arrange 📐
      jest.useFakeTimers();
      const { strategy } = buildStrategy();

      // 2. Act ⚙️: sin avanzar los temporizadores. Si esperase, no resolveria.
      const result = await strategy.execute(buildContext(), {
        pauseMode: 'IMMEDIATE',
      });

      // 3. Assert 🎯
      expect(result.pause).toBeDefined();
      expect(result.data?.delayed_seconds).toBe(0);
    });

    it('2.2 deberia esperar los segundos configurados antes de resolver', async () => {
      // 1. Arrange 📐
      jest.useFakeTimers();
      const { strategy } = buildStrategy();
      let settled = false;

      // 2. Act ⚙️
      const pending = strategy
        .execute(buildContext(), { pauseMode: 'DELAYED', delaySeconds: 300 })
        .then((value) => {
          settled = true;

          return value;
        });

      await jest.advanceTimersByTimeAsync(299_000);
      const settledTooEarly = settled;

      await jest.advanceTimersByTimeAsync(1_000);
      const result = await pending;

      // 3. Assert 🎯
      expect(settledTooEarly).toBe(false);
      expect(result.data?.delayed_seconds).toBe(300);
    });

    it('2.3 deberia IGNORAR el retardo si el modo volvio a inmediato', async () => {
      // 1. Arrange 📐: un operador que configuro una espera y luego eligio
      //    "Pausa inmediata" dejaria si no un `delaySeconds` huerfano que el
      //    nodo respetaria igualmente. Lo que manda es el modo.
      jest.useFakeTimers();
      const { strategy } = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        pauseMode: 'IMMEDIATE',
        delaySeconds: 300,
      });

      // 3. Assert 🎯
      expect(result.data?.delayed_seconds).toBe(0);
    });

    it('2.4 deberia RECHAZAR un retardo por encima del tope', async () => {
      // 1. Arrange 📐: la espera transcurre con la ejecucion viva ocupando
      //    capacidad global, asi que el tope no es cosmetico.
      const { strategy } = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        pauseMode: 'DELAYED',
        delaySeconds: 100_000,
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_PAUSE_CONFIG);
      expect(result.error?.missingFields).toContain('delaySeconds');
    });
  });

  describe('3. Aviso informativo', () => {
    it('3.1 NO deberia enviar correo si no se pidio', async () => {
      // 1. Arrange 📐
      const { strategy, mailer } = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {});

      // 3. Assert 🎯
      expect(mailer.sendNodeAlert).not.toHaveBeenCalled();
      expect(result.data?.notified).toBe('');
    });

    it('3.2 deberia despachar el aviso al destinatario configurado', async () => {
      // 1. Arrange 📐
      const { strategy, mailer } = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        notifyOnPause: true,
        notificationRecipient: RECIPIENT,
      });

      // 3. Assert 🎯
      expect(mailer.sendNodeAlert).toHaveBeenCalledTimes(1);
      expect(result.data?.notified).toBe(RECIPIENT);
    });

    it('3.3 deberia titular el correo con el nombre del flujo, sin lenguaje de alarma', async () => {
      // 1. Arrange 📐: el enunciado del nodo es explicito en que este aviso no
      //    debe alertar de gravedad tecnica.
      const { strategy, mailer } = buildStrategy();

      // 2. Act ⚙️
      await strategy.execute(buildContext(), {
        notifyOnPause: true,
        notificationRecipient: RECIPIENT,
      });

      // 3. Assert 🎯
      const [message] = mailer.sendNodeAlert.mock.calls.at(0) as [
        { subject: string; text: string },
      ];

      expect(message.subject).toBe('[PROTO-DO] Flujo pausado: Notiweb diario');
      expect(message.text).toContain('AVISO DE PAUSA PROGRAMADA');
      expect(message.text).not.toContain('INCIDENCIA');
    });

    it('3.4 deberia PAUSAR IGUALMENTE si el correo falla', async () => {
      // 1. Arrange 📐: la pausa es el trabajo del nodo y el correo una
      //    cortesia. Convertir un transporte caido en un fallo del nodo
      //    desviaria el flujo por `onErrorStep` en vez de detenerlo.
      const mailer = buildMailer();
      mailer.sendNodeAlert.mockRejectedValue(
        new InternalServerErrorException('SMTP caido'),
      );
      const { strategy } = buildStrategy(mailer);

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        notifyOnPause: true,
        notificationRecipient: RECIPIENT,
      });

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.pause).toEqual({ reason: PROGRAMMED_PAUSE_REASON });
      expect(result.data?.notified).toBe('');
    });
  });

  describe('4. Completitud para ACTIVAR', () => {
    it('4.1 deberia considerar completo el nodo sin configurar', () => {
      // 1. Arrange 📐: una plantilla de flujo trae los `params` vacios a
      //    proposito, y el nodo sabe pausar sin que le digan nada.
      const { strategy } = buildStrategy();

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(strategy.getIncompleteParams({})).toEqual([]);
    });

    it('4.2 deberia exigir destinatario cuando se activa el aviso', () => {
      // 1. Arrange 📐
      const { strategy } = buildStrategy();

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(strategy.getIncompleteParams({ notifyOnPause: true })).toEqual([
        'notificationRecipients',
      ]);
    });

    it('4.3 deberia exigir los segundos cuando el modo es diferido', () => {
      // 1. Arrange 📐
      const { strategy } = buildStrategy();

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(strategy.getIncompleteParams({ pauseMode: 'DELAYED' })).toEqual([
        'delaySeconds',
      ]);
    });

    it('4.4 deberia rechazar en ejecucion un nodo incompleto', async () => {
      // 1. Arrange 📐: `getIncompleteParams` solo bloquea al ACTIVAR, asi que
      //    `execute` vuelve a preguntarlo con el mismo criterio.
      const { strategy, mailer } = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        notifyOnPause: true,
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_PAUSE_CONFIG);
      expect(mailer.sendNodeAlert).not.toHaveBeenCalled();
    });
  });
});
