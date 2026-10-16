import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_PAUSE_DELAY_SECONDS,
  MAX_PAUSE_DELAY_SECONDS,
  PauseTriggerMode,
} from '@/types/nodes/pause-flow.types';

import { usePauseFlowStore } from './pause-flow.store';

const RECIPIENT = 'operaciones@unuware.com';

/**
 * `nodeId` unico por prueba.
 *
 * Las definiciones de Pinia se memoizan en un `Map` de MODULO que sobrevive
 * entre pruebas, asi que reutilizar un id arrastraria el estado de la anterior.
 */
let nodeCounter = 0;
const nextNodeId = (): string => `pausa_flow_${(nodeCounter += 1)}`;

describe('usePauseFlowStore · configuracion del nodo PAUSA_FLOW', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  describe('1. Estado inicial', () => {
    it('1.1 deberia arrancar en pausa inmediata y sin retardo', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const store = usePauseFlowStore(nextNodeId());

      // 3. Assert 🎯
      expect(store.config.pauseMode).toBe(PauseTriggerMode.IMMEDIATE);
      expect(store.config.delaySeconds).toBe(0);
      expect(store.isDelayed).toBe(false);
    });

    it('1.2 deberia ser VALIDO sin configurar nada', () => {
      // 1. Arrange 📐: es la diferencia con los demas nodos. Este sabe hacer su
      //    trabajo —detener el flujo— sin que nadie le diga nada, asi que
      //    bloquear el asistente seria un Poka-Yoke al reves.
      const store = usePauseFlowStore(nextNodeId());

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(store.isConfigValid).toBe(true);
    });
  });

  describe('2. Modo y retardo', () => {
    it('2.1 deberia PROPONER un retardo al pasar a diferido', () => {
      // 1. Arrange 📐: dejarlo en cero pondria el formulario en rojo nada mas
      //    pulsar el conmutador, sin que el operador hubiera hecho nada mal.
      const store = usePauseFlowStore(nextNodeId());

      // 2. Act ⚙️
      store.setPauseMode(PauseTriggerMode.DELAYED);

      // 3. Assert 🎯
      expect(store.config.delaySeconds).toBe(DEFAULT_PAUSE_DELAY_SECONDS);
      expect(store.isConfigValid).toBe(true);
    });

    it('2.2 NO deberia pisar un retardo que el operador ya eligio', () => {
      // 1. Arrange 📐
      const store = usePauseFlowStore(nextNodeId());
      store.setPauseMode(PauseTriggerMode.DELAYED);
      store.updateConfig({ delaySeconds: 42 });

      // 2. Act ⚙️: vuelve a inmediata y otra vez a diferida.
      store.setPauseMode(PauseTriggerMode.IMMEDIATE);
      store.setPauseMode(PauseTriggerMode.DELAYED);

      // 3. Assert 🎯
      expect(store.config.delaySeconds).toBe(42);
    });

    it('2.3 deberia invalidar un retardo por encima del tope', () => {
      // 1. Arrange 📐: la espera ocupa capacidad del motor, asi que el tope se
      //    replica aqui para impedirlo antes de que el backend lo rechace.
      const store = usePauseFlowStore(nextNodeId());

      // 2. Act ⚙️
      store.setPauseMode(PauseTriggerMode.DELAYED);
      store.updateConfig({ delaySeconds: MAX_PAUSE_DELAY_SECONDS + 1 });

      // 3. Assert 🎯
      expect(store.isDelayOutOfRange).toBe(true);
      expect(store.isConfigValid).toBe(false);
    });

    it('2.4 NO deberia mirar el retardo en modo inmediato', () => {
      // 1. Arrange 📐: un valor huerfano de cuando se probo la otra opcion no
      //    puede bloquear un nodo que ya no lo usa.
      const store = usePauseFlowStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ delaySeconds: MAX_PAUSE_DELAY_SECONDS + 1 });

      // 3. Assert 🎯
      expect(store.isDelayOutOfRange).toBe(false);
      expect(store.isConfigValid).toBe(true);
    });
  });

  describe('3. Aviso por correo', () => {
    it('3.1 deberia exigir destinatario al activar el aviso', () => {
      // 1. Arrange 📐: a quien avisar no lo puede adivinar nadie. Es lo mismo
      //    que `getIncompleteParams` exige en el backend para ACTIVAR.
      const store = usePauseFlowStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ notifyOnPause: true });

      // 3. Assert 🎯
      expect(store.isConfigValid).toBe(false);
    });

    it('3.2 deberia rechazar un destinatario con forma invalida', () => {
      // 1. Arrange 📐
      const store = usePauseFlowStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ notifyOnPause: true, notificationRecipient: 'no-es-un-correo' });

      // 3. Assert 🎯
      expect(store.isRecipientInvalid).toBe(true);
      expect(store.isConfigValid).toBe(false);
    });

    it('3.3 deberia validar con un destinatario correcto', () => {
      // 1. Arrange 📐
      const store = usePauseFlowStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ notifyOnPause: true, notificationRecipient: RECIPIENT });

      // 3. Assert 🎯
      expect(store.isConfigValid).toBe(true);
    });
  });

  describe('4. Publicacion en el pipeline_schema', () => {
    it('4.1 deberia publicar solo el modo cuando no hay nada mas', () => {
      // 1. Arrange 📐: lo vacio se OMITE. El DTO valida `@IsNotEmpty` sobre el
      //    mensaje si la clave viene, asi que publicar `''` daria un 400 sobre
      //    el flujo entero.
      const store = usePauseFlowStore(nextNodeId());

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(store.toNodeParams()).toEqual({ pauseMode: PauseTriggerMode.IMMEDIATE });
    });

    it('4.2 NO deberia publicar el retardo en modo inmediato', () => {
      // 1. Arrange 📐: espejo de `resolvePauseFlowConfig` en el backend. Un
      //    retardo huerfano confundiria a quien reabriera el nodo.
      const store = usePauseFlowStore(nextNodeId());
      store.updateConfig({ delaySeconds: 300 });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(store.toNodeParams()).not.toHaveProperty('delaySeconds');
    });

    it('4.3 deberia publicar el retardo en modo diferido', () => {
      // 1. Arrange 📐
      const store = usePauseFlowStore(nextNodeId());

      // 2. Act ⚙️
      store.setPauseMode(PauseTriggerMode.DELAYED);

      // 3. Assert 🎯
      expect(store.toNodeParams()).toMatchObject({
        pauseMode: PauseTriggerMode.DELAYED,
        delaySeconds: DEFAULT_PAUSE_DELAY_SECONDS,
      });
    });

    it('4.4 deberia recortar el mensaje y omitirlo si queda vacio', () => {
      // 1. Arrange 📐
      const store = usePauseFlowStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ customPauseMessage: '   ' });

      // 3. Assert 🎯
      expect(store.toNodeParams()).not.toHaveProperty('customPauseMessage');
    });
  });

  describe('5. Ida y vuelta con un nodo guardado', () => {
    it('5.1 deberia reproducir los params al hidratar y volver a publicar', () => {
      // 1. Arrange 📐: contrato de ida y vuelta. Sin el, reabrir un nodo y
      //    cerrarlo cambiaria su configuracion sin que nadie lo pidiera.
      const store = usePauseFlowStore(nextNodeId());
      const params = {
        pauseMode: PauseTriggerMode.DELAYED,
        delaySeconds: 120,
        notifyOnPause: true,
        notificationRecipient: RECIPIENT,
        customPauseMessage: 'A la espera de revision.',
      };

      // 2. Act ⚙️
      store.hydrateFromNode({ nodeId: 'pausa', nodeType: 'PAUSA_FLOW', params } as never);

      // 3. Assert 🎯
      expect(store.toNodeParams()).toEqual(params);
    });

    it('5.2 deberia tolerar un `pauseMode` corrupto cayendo a inmediato', () => {
      // 1. Arrange 📐: la columna es `jsonb` y pudo escribirse por SQL directo.
      //    Un valor fuera del enum dejaria el `q-btn-toggle` sin ninguna opcion
      //    marcada, que es un control que el operador no puede arreglar.
      const store = usePauseFlowStore(nextNodeId());

      // 2. Act ⚙️
      store.hydrateFromNode({
        nodeId: 'pausa',
        nodeType: 'PAUSA_FLOW',
        params: { pauseMode: 'CUANDO_SEA' },
      } as never);

      // 3. Assert 🎯
      expect(store.config.pauseMode).toBe(PauseTriggerMode.IMMEDIATE);
    });

    it('5.3 deberia descartar un retardo no entero', () => {
      // 1. Arrange 📐
      const store = usePauseFlowStore(nextNodeId());

      // 2. Act ⚙️
      store.hydrateFromNode({
        nodeId: 'pausa',
        nodeType: 'PAUSA_FLOW',
        params: { pauseMode: PauseTriggerMode.DELAYED, delaySeconds: 12.5 },
      } as never);

      // 3. Assert 🎯
      expect(store.config.delaySeconds).toBe(0);
    });
  });
});
