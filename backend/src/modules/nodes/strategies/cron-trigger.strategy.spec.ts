import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { DEFAULT_CRON_TIMEZONE } from '@modules/nodes/dto/cron-trigger-config.dto';
import { createMockStatePayloadContext } from '@test/factories/state-payload-context.factory';

import { CronTriggerStrategy } from './cron-trigger.strategy';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';

const VALID_EXPRESSION = '0 9 * * 1-5';

const buildContext = (): StatePayloadContext =>
  createMockStatePayloadContext({ currentStep: 'trigger_cron' });

describe('CronTriggerStrategy', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('0. Identidad del nodo', () => {
    it('0.1 deberia declararse como el nodo TRIGGER_CRON', () => {
      // 1. Arrange & 2. Act
      const strategy = new CronTriggerStrategy();

      // 3. Assert: la factoria indexa por este valor.
      expect(strategy.nodeType).toBe(NodeType.TRIGGER_CRON);
    });
  });

  describe('1. Disparo con configuracion valida', () => {
    it('1.1 deberia devolver la marca temporal y la programacion vigente', async () => {
      // 1. Arrange
      const strategy = new CronTriggerStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        cronExpression: VALID_EXPRESSION,
        timeZone: 'UTC',
      });

      // 3. Assert: se comprueban las claves y luego cada valor, en vez de un
      // `toEqual` con `expect.any`, que devuelve `any` y el lint rechaza.
      expect(Object.keys(result.data ?? {}).sort()).toEqual([
        'cron_expression',
        'next_run_at',
        'time_zone',
        'triggered_at',
      ]);
      expect(result.success).toBe(true);
      expect(result.data?.cron_expression).toBe(VALID_EXPRESSION);
      expect(result.data?.time_zone).toBe('UTC');
      expect(typeof result.data?.triggered_at).toBe('string');
      expect(typeof result.data?.next_run_at).toBe('string');
    });

    it('1.2 deberia aplicar la zona horaria por defecto', async () => {
      // 1. Arrange
      const strategy = new CronTriggerStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        cronExpression: VALID_EXPRESSION,
      });

      // 3. Assert
      expect(result.data?.time_zone).toBe(DEFAULT_CRON_TIMEZONE);
    });

    it('1.3 deberia emitir triggered_at como instante ISO parseable', async () => {
      // 1. Arrange
      const strategy = new CronTriggerStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        cronExpression: VALID_EXPRESSION,
      });

      // 3. Assert
      const triggeredAt = Date.parse(String(result.data?.triggered_at));
      expect(Number.isNaN(triggeredAt)).toBe(false);
    });

    it('1.4 deberia situar next_run_at en el futuro', async () => {
      // 1. Arrange
      const strategy = new CronTriggerStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        cronExpression: '*/5 * * * *',
      });

      // 3. Assert
      expect(Date.parse(String(result.data?.next_run_at))).toBeGreaterThan(
        Date.now(),
      );
    });

    it('1.5 deberia degradar next_run_at a null si CronTime no puede resolver la zona', () => {
      // 1. Arrange: `CronTime` lanza CronError con zonas que Intl acepta pero
      //    luxon no, y ese hueco no lo cubre el validador del DTO. El campo es
      //    de observabilidad, asi que no puede tumbar el nodo.
      const strategy = new CronTriggerStrategy();
      const warnSpy = jest
        .spyOn(strategy['logger'], 'warn')
        .mockImplementation(() => undefined);

      // 2. Act
      const nextRun = strategy['resolveNextRun']({
        cronExpression: VALID_EXPRESSION,
        timeZone: 'Zona/Inexistente',
        outputNamespace: 'cron_trigger',
      });

      // 3. Assert
      expect(nextRun).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('2. Configuracion invalida', () => {
    it('2.1 deberia devolver GRAVE y no lanzar si falta la expresion', async () => {
      // 1. Arrange: GRAVE y no URGENTE porque es lo que deja el flujo PAUSADO
      //    y reanudable por CU-09.
      const strategy = new CronTriggerStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), {});

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.missingFields).toContain('cronExpression');
    });

    it('2.2 deberia rechazar una expresion de seis campos', async () => {
      // 1. Arrange
      const strategy = new CronTriggerStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        cronExpression: '* * * * * *',
      });

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.missingFields).toContain('cronExpression');
    });

    it('2.3 deberia rechazar una clave desconocida en params', async () => {
      // 1. Arrange
      const strategy = new CronTriggerStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        cronExpression: VALID_EXPRESSION,
        cronExpresion: '* * * * *',
      });

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.missingFields).toContain('cronExpresion');
    });

    it('2.4 deberia incluir el detalle del constraint en el mensaje', async () => {
      // 1. Arrange
      const strategy = new CronTriggerStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        cronExpression: VALID_EXPRESSION,
        timeZone: '+02:00',
      });

      // 3. Assert
      expect(result.error?.message).toContain('timeZone');
    });
  });

  describe('3. Inmutabilidad del contexto', () => {
    it('3.1 no deberia escribir en el contexto', async () => {
      // 1. Arrange: depositar la salida en el namespace es trabajo del motor.
      const strategy = new CronTriggerStrategy();
      const context = buildContext();
      const before = context.getAllContext();

      // 2. Act
      await strategy.execute(context, { cronExpression: VALID_EXPRESSION });

      // 3. Assert
      expect(context.getAllContext()).toEqual(before);
    });
  });

  describe('4. Inventario de salida (outputFields)', () => {
    it('4.1 deberia declarar las cuatro claves en el orden del payload', () => {
      // 1. Arrange & 2. Act
      const strategy = new CronTriggerStrategy();

      // 3. Assert: es lo que el catalogo sirve al selector del asistente.
      expect(strategy.outputFields.map((field) => field.name)).toEqual([
        'triggered_at',
        'cron_expression',
        'time_zone',
        'next_run_at',
      ]);
    });

    it('4.2 deberia coincidir exactamente con las claves que emite execute', async () => {
      // 1. Arrange: la guarda contra la desincronizacion entre el inventario
      // declarado y el `data` real. Anadir una clave sin declararla rompe aqui.
      const strategy = new CronTriggerStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        cronExpression: VALID_EXPRESSION,
      });

      // 3. Assert
      expect(Object.keys(result.data ?? {}).sort()).toEqual(
        strategy.outputFields.map((field) => field.name).sort(),
      );
    });

    it('4.3 no deberia ofrecer ningun campo como origen de URL', () => {
      // 1. Arrange & 2. Act
      const strategy = new CronTriggerStrategy();

      // 3. Assert: una expresion cron y tres marcas de tiempo no son
      // direcciones; la regla 8 del validador debe seguir rechazando un
      // EXTRACTOR_WEB que solo tenga este nodo aguas arriba.
      const urlFields = strategy.outputFields.filter(
        (field) => field.type === 'url' || field.type === 'url[]',
      );
      expect(urlFields).toEqual([]);
    });
  });
});
