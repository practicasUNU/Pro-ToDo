import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  CRON_TIMEZONE_OPTIONS,
  DEFAULT_CRON_TIMEZONE,
  isLikelyCronExpression,
  useTriggerCronStore,
} from './trigger-cron.store';

/**
 * `nodeId` del nodo bajo prueba.
 *
 * El store se instancia POR NODO, asi que toda prueba tiene que nombrar el nodo
 * al que pregunta.
 */
const NODE_ID = 'trigger_cron';

const VALID_EXPRESSION = '0 9 * * 1-5';

describe('useTriggerCronStore · configuracion del nodo TRIGGER_CRON', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  describe('1. Validacion de la expresion en el cliente', () => {
    it.each(['0 9 * * 1-5', '*/15 * * * *', '0 0 1 * *', '30 8 * * 1'])(
      '1.1 deberia aceptar "%s"',
      (expression) => {
        // 1. Arrange & 2. Act & 3. Assert
        expect(isLikelyCronExpression(expression)).toBe(true);
      },
    );

    it.each([
      ['todos los lunes', 'texto libre'],
      ['* * * * * *', 'seis campos (segundos)'],
      ['@daily', 'alias con arroba'],
      ['* * * *', 'cuatro campos'],
      ['   ', 'solo espacios'],
    ])('1.2 deberia rechazar "%s" (%s)', (expression) => {
      // 1. Arrange & 2. Act & 3. Assert
      expect(isLikelyCronExpression(expression)).toBe(false);
    });

    it('1.3 no deberia bloquear un rango fuera de limites', () => {
      // 1. Arrange: la validacion del cliente atrapa el error de forma, no el
      //    analisis completo. `99` lo sigue rechazando el backend, y duplicar
      //    aqui el analizador entero seria mantener dos fuentes de verdad.
      // 2. Act & 3. Assert
      expect(isLikelyCronExpression('99 * * * *')).toBe(true);
    });
  });

  describe('2. Estado inicial y validez', () => {
    it('2.1 deberia arrancar sin expresion y con la zona por defecto', () => {
      // 1. Arrange & 2. Act
      const store = useTriggerCronStore(NODE_ID);

      // 3. Assert
      expect(store.config.cronExpression).toBe('');
      expect(store.config.timeZone).toBe(DEFAULT_CRON_TIMEZONE);
      expect(store.isConfigValid).toBe(false);
    });

    it('2.2 deberia considerarse valido con una expresion correcta', () => {
      // 1. Arrange
      const store = useTriggerCronStore(NODE_ID);

      // 2. Act
      store.patchConfig({ cronExpression: VALID_EXPRESSION });

      // 3. Assert: sin esto el boton Siguiente del asistente no se habilita.
      expect(store.isConfigValid).toBe(true);
    });

    it('2.3 deberia invalidarse con una zona fuera del selector', () => {
      // 1. Arrange: el selector es cerrado, pero un nodo hidratado desde SQL
      //    directo puede traer cualquier cosa.
      const store = useTriggerCronStore(NODE_ID);

      // 2. Act
      store.patchConfig({
        cronExpression: VALID_EXPRESSION,
        timeZone: 'Marte/Olympus',
      });

      // 3. Assert
      expect(store.isConfigValid).toBe(false);
    });

    it('2.4 deberia ofrecer la zona por defecto entre las opciones', () => {
      // 1. Arrange & 2. Act & 3. Assert: si no estuviera, el estado inicial
      //    seria invalido de partida y el selector abriria sin seleccion.
      expect(CRON_TIMEZONE_OPTIONS).toContain(DEFAULT_CRON_TIMEZONE);
    });
  });

  describe('3. Contrato con el pipeline_schema', () => {
    it('3.1 deberia publicar solo cronExpression y timeZone', () => {
      // 1. Arrange
      const store = useTriggerCronStore(NODE_ID);
      store.patchConfig({ cronExpression: VALID_EXPRESSION, timeZone: 'UTC' });

      // 2. Act
      const params = store.toNodeParams();

      // 3. Assert: `outputNamespace` es propiedad del nodo en el esquema, no de
      //    sus `params`; publicarlo aqui crearia dos fuentes de verdad.
      expect(params).toEqual({
        cronExpression: VALID_EXPRESSION,
        timeZone: 'UTC',
      });
    });

    it('3.2 deberia recortar los espacios de la expresion', () => {
      // 1. Arrange: el planificador compara configuraciones por JSON, asi que
      //    un espacio de sobra contaria como cambio y reinscribiria el job.
      const store = useTriggerCronStore(NODE_ID);
      store.patchConfig({ cronExpression: `  ${VALID_EXPRESSION}  ` });

      // 2. Act
      const params = store.toNodeParams();

      // 3. Assert
      expect(params.cronExpression).toBe(VALID_EXPRESSION);
    });

    it('3.3 deberia reproducir los params al hidratar y volver a publicar', () => {
      // 1. Arrange: contrato de ida y vuelta del registro de stores.
      const store = useTriggerCronStore(NODE_ID);
      const params = { cronExpression: '*/30 * * * *', timeZone: 'UTC' };

      // 2. Act
      store.hydrateFromNode({ outputNamespace: 'cron_trigger', params });

      // 3. Assert
      expect(store.toNodeParams()).toEqual(params);
    });

    it('3.4 deberia reponer la zona por defecto si el nodo guardado no la traia', () => {
      // 1. Arrange: sin esto el selector quedaria sin seleccion en un nodo que
      //    si tiene una zona efectiva, la que aplica el backend.
      const store = useTriggerCronStore(NODE_ID);

      // 2. Act
      store.hydrateFromNode({
        outputNamespace: 'cron_trigger',
        params: { cronExpression: VALID_EXPRESSION },
      });

      // 3. Assert
      expect(store.config.timeZone).toBe(DEFAULT_CRON_TIMEZONE);
      expect(store.isConfigValid).toBe(true);
    });

    it('3.5 deberia devolver el nodo a su estado inicial', () => {
      // 1. Arrange: la instancia sobrevive a la topologia que la creo, asi que
      //    sin esto un flujo nuevo arrancaria con los params del anterior.
      const store = useTriggerCronStore(NODE_ID);
      store.patchConfig({ cronExpression: VALID_EXPRESSION, timeZone: 'UTC' });

      // 2. Act
      store.resetConfig();

      // 3. Assert
      expect(store.config.cronExpression).toBe('');
      expect(store.config.timeZone).toBe(DEFAULT_CRON_TIMEZONE);
      expect(store.isConfigValid).toBe(false);
    });
  });
});
