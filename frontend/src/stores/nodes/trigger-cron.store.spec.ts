import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  CRON_TIMEZONE_SUGGESTIONS,
  DEFAULT_CRON_TIMEZONE,
  isIanaTimeZone,
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

  describe('1bis. Validacion de la zona horaria', () => {
    it.each([
      ['Europe/Madrid', 'zona de la organizacion'],
      ['UTC', 'el unico nombre valido sin barra'],
      ['Asia/Tokyo', 'zona fuera de las sugerencias'],
      ['America/Argentina/Buenos_Aires', 'nombre de tres segmentos'],
      ['Asia/Calcutta', 'alias historico que supportedValuesOf omite'],
    ])('1bis.1 deberia aceptar "%s" (%s)', (timeZone) => {
      // 1. Arrange & 2. Act & 3. Assert
      expect(isIanaTimeZone(timeZone)).toBe(true);
    });

    it.each([
      ['', 'cadena vacia'],
      ['Marte/Olympus', 'zona inexistente'],
      ['Europe/Madird', 'nombre mal escrito'],
      ['+02:00', 'desplazamiento fijo'],
      ['UTC+2', 'desplazamiento con prefijo UTC'],
      ['GMT', 'alias sin barra'],
    ])('1bis.2 deberia rechazar "%s" (%s)', (timeZone) => {
      // 1. Arrange & 2. Act & 3. Assert
      expect(isIanaTimeZone(timeZone)).toBe(false);
    });

    it('1bis.3 deberia dejar pasar Etc/GMT+2, deuda conocida compartida con el backend', () => {
      // 1. Arrange: lleva barra y `Intl` lo resuelve, asi que la regla no lo
      //    distingue de una zona real pese a ser un desplazamiento fijo. Se fija
      //    aqui para que el dia que se corrija se corrija en AMBAS capas: hacerlo
      //    solo en el cliente recrearia la divergencia que este espejo elimina.
      // 2. Act & 3. Assert
      expect(isIanaTimeZone('Etc/GMT+2')).toBe(true);
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

    it('2.3 deberia invalidarse con una zona que Intl no resuelve', () => {
      // 1. Arrange: el selector ya no es cerrado, pero un nombre inventado
      //    —tecleado o llegado por SQL directo— sigue sin ser programable.
      const store = useTriggerCronStore(NODE_ID);

      // 2. Act
      store.patchConfig({
        cronExpression: VALID_EXPRESSION,
        timeZone: 'Marte/Olympus',
      });

      // 3. Assert
      expect(store.isConfigValid).toBe(false);
    });

    it('2.4 deberia ofrecer la zona por defecto entre las sugerencias', () => {
      // 1. Arrange & 2. Act & 3. Assert: no condiciona la validez —de eso se
      //    ocupa `isIanaTimeZone`— pero sin ella el selector abriria sin
      //    destacar la zona con la que el nodo arranca.
      expect(CRON_TIMEZONE_SUGGESTIONS).toContain(DEFAULT_CRON_TIMEZONE);
    });

    it('2.5 deberia aceptar una zona IANA fuera de las sugerencias', () => {
      // 1. Arrange: REGRESION. La lista cerrada declaraba invalida una zona que
      //    el backend si acepta, y eso bloqueaba el guardado del flujo entero.
      const store = useTriggerCronStore(NODE_ID);

      // 2. Act
      store.patchConfig({
        cronExpression: VALID_EXPRESSION,
        timeZone: 'Asia/Tokyo',
      });

      // 3. Assert
      expect(store.isConfigValid).toBe(true);
    });

    it('2.6 deberia seguir rechazando un desplazamiento fijo', () => {
      // 1. Arrange: abrir la entrada no significa aceptar cualquier cosa.
      const store = useTriggerCronStore(NODE_ID);

      // 2. Act
      store.patchConfig({
        cronExpression: VALID_EXPRESSION,
        timeZone: '+02:00',
      });

      // 3. Assert
      expect(store.isConfigValid).toBe(false);
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

    it('3.5bis deberia poder reguardar un nodo hidratado con una zona no sugerida', () => {
      // 1. Arrange: el escenario exacto que bloqueaba el guardado. El nodo se
      //    guardo con una zona que el backend acepta y el asistente rechazaba.
      const store = useTriggerCronStore(NODE_ID);
      const params = { cronExpression: '0 9 * * *', timeZone: 'Asia/Tokyo' };

      // 2. Act
      store.hydrateFromNode({ outputNamespace: 'cron_trigger', params });

      // 3. Assert
      expect(store.isConfigValid).toBe(true);
      expect(store.toNodeParams()).toEqual(params);
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
