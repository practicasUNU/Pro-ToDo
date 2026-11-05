import { Logger } from '@nestjs/common';

import {
  DEFAULT_MAX_EXECUTIONS_PER_POLL_TICK,
  DEFAULT_MAX_GLOBAL_CONCURRENT_EXECUTIONS,
  FsmConfig,
  MAX_EXECUTIONS_PER_POLL_TICK_VAR,
  MAX_GLOBAL_CONCURRENT_EXECUTIONS_VAR,
} from './fsm.config';

import type { ConfigService } from '@nestjs/config';

/** Entorno simulado: un mapa de variable a valor. */
const buildConfigService = (env: Record<string, string>): ConfigService =>
  ({
    get: jest.fn((variable: string) => env[variable]),
  }) as unknown as ConfigService;

const buildConfig = (env: Record<string, string> = {}): FsmConfig =>
  new FsmConfig(buildConfigService(env));

describe('FsmConfig', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    // El aviso es parte del contrato —una errata no puede decidirse en
    // silencio—, pero ensuciaria la salida de Jest en los casos negativos.
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('1. Techo global de ejecuciones simultaneas', () => {
    it('1.1 deberia leer el valor declarado en el entorno', () => {
      // 1. Arrange 📐
      const config = buildConfig({
        [MAX_GLOBAL_CONCURRENT_EXECUTIONS_VAR]: '12',
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(config.maxGlobalConcurrentExecutions).toBe(12);
    });

    it('1.2 deberia caer al defecto cuando la variable no esta declarada', () => {
      // 1. Arrange 📐: el backend tiene que arrancar sin esta variable; un
      //    `.env` heredado de antes de la barrera no la lleva.
      const config = buildConfig();

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(config.maxGlobalConcurrentExecutions).toBe(
        DEFAULT_MAX_GLOBAL_CONCURRENT_EXECUTIONS,
      );
      expect(warnSpy).not.toHaveBeenCalled();
    });

    // El cero merece mencion aparte: no limita, PARALIZA. Un techo de cero
    // haria que `createExecution` rechazase absolutamente todo, y el sintoma
    // —ningun flujo vuelve a ejecutarse— no apunta a una variable mal puesta.
    // Para apagar el disparo ya existe `IMAP_POLLING_ENABLED`.
    it.each(['0', '-1', 'cinco', '', '  ', '2.5'])(
      '1.3 deberia rechazar el valor %p y avisar',
      (rawValue: string) => {
        // 1. Arrange 📐
        const config = buildConfig({
          [MAX_GLOBAL_CONCURRENT_EXECUTIONS_VAR]: rawValue,
        });

        // 2. Act ⚙️
        const resolved = config.maxGlobalConcurrentExecutions;

        // 3. Assert 🎯
        expect(resolved).toBe(DEFAULT_MAX_GLOBAL_CONCURRENT_EXECUTIONS);
      },
    );

    it('1.4 deberia nombrar la variable y el valor en el aviso', () => {
      // 1. Arrange 📐: sin el nombre, el aviso obliga a revisar el `.env`
      //    entero para saber cual de los dos techos esta mal escrito.
      const config = buildConfig({
        [MAX_GLOBAL_CONCURRENT_EXECUTIONS_VAR]: 'cinco',
      });

      // 2. Act ⚙️
      void config.maxGlobalConcurrentExecutions;

      // 3. Assert 🎯
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(MAX_GLOBAL_CONCURRENT_EXECUTIONS_VAR),
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cinco'));
    });

    it('1.5 deberia admitir 1, que es el minimo con sentido', () => {
      // 1. Arrange 📐: es el ajuste con el que se verifica la barrera a mano.
      const config = buildConfig({
        [MAX_GLOBAL_CONCURRENT_EXECUTIONS_VAR]: '1',
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(config.maxGlobalConcurrentExecutions).toBe(1);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('2. Tamano del lote por ciclo de disparo', () => {
    it('2.1 deberia leer el valor declarado en el entorno', () => {
      // 1. Arrange 📐
      const config = buildConfig({
        [MAX_EXECUTIONS_PER_POLL_TICK_VAR]: '10',
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(config.maxExecutionsPerPollTick).toBe(10);
    });

    it('2.2 deberia caer al defecto cuando la variable no esta declarada', () => {
      // 1. Arrange 📐
      const config = buildConfig();

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(config.maxExecutionsPerPollTick).toBe(
        DEFAULT_MAX_EXECUTIONS_PER_POLL_TICK,
      );
    });

    // Un lote de cero deja el buzon sin sondear pese a tener el disparo
    // encendido: el ciclo detecta correos y no despacha ninguno.
    it.each(['0', '-3', 'tres', '', '1.5'])(
      '2.3 deberia rechazar el valor %p y usar el de por defecto',
      (rawValue: string) => {
        // 1. Arrange 📐
        const config = buildConfig({
          [MAX_EXECUTIONS_PER_POLL_TICK_VAR]: rawValue,
        });

        // 2. Act ⚙️ + 3. Assert 🎯
        expect(config.maxExecutionsPerPollTick).toBe(
          DEFAULT_MAX_EXECUTIONS_PER_POLL_TICK,
        );
      },
    );
  });

  describe('3. Independencia de los dos techos', () => {
    it('3.1 no deberia contaminar un techo con el valor del otro', () => {
      // 1. Arrange 📐: describen cosas distintas —cuantas ejecuciones caben a
      //    la vez frente a cuantas se encadenan en un ciclo— y una errata en
      //    una no puede arrastrar a la otra a su defecto.
      const config = buildConfig({
        [MAX_GLOBAL_CONCURRENT_EXECUTIONS_VAR]: 'invalido',
        [MAX_EXECUTIONS_PER_POLL_TICK_VAR]: '7',
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(config.maxGlobalConcurrentExecutions).toBe(
        DEFAULT_MAX_GLOBAL_CONCURRENT_EXECUTIONS,
      );
      expect(config.maxExecutionsPerPollTick).toBe(7);
    });
  });
});
