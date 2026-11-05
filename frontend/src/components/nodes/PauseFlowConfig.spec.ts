// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO, igual que en los demas configuradores: los specs de
// store no necesitan DOM y arrancan mas rapido sin el.
import { config, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { Notify, QBanner, QBtnToggle, QIcon, QInput, QSelect, QToggle, Quasar } from 'quasar';
import { beforeEach, describe, expect, it } from 'vitest';

import PauseFlowConfig from '@components/nodes/PauseFlowConfig.vue';
import { usePauseFlowStore } from '@stores/nodes/pause-flow.store';

import { MAX_PAUSE_DELAY_SECONDS, PauseTriggerMode } from '@/types/nodes/pause-flow.types';

const RECIPIENT = 'operaciones@unuware.com';

/** `nodeId` unico por prueba: las definiciones de Pinia se memoizan por modulo. */
let nodeCounter = 0;
const nextNodeId = (): string => `pause_flow_view_${(nodeCounter += 1)}`;

const QUASAR_COMPONENTS = { QBanner, QBtnToggle, QIcon, QInput, QSelect, QToggle };

const mountComponent = (nodeId: string): ReturnType<typeof mount> =>
  mount(PauseFlowConfig, {
    props: { nodeId },
    global: { plugins: [[Quasar, { plugins: { Notify } }]], components: QUASAR_COMPONENTS },
  });

describe('PauseFlowConfig · configurador del nodo PAUSA_FLOW', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    config.global.plugins = [];
  });

  describe('1. Montaje', () => {
    it('1.1 deberia pintar el conmutador de modo', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = mountComponent(nextNodeId());

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="pause-mode"]').exists()).toBe(true);
    });

    it('1.2 deberia advertir de que nadie reanuda el flujo solo', () => {
      // 1. Arrange 📐: es la informacion que mas falta hace aqui. El nombre
      //    "pausa programada" invita a pensar que el flujo volvera por su
      //    cuenta, y no lo hace ni lo hara.
      const wrapper = mountComponent(nextNodeId());

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(wrapper.get('[data-test="resume-notice"]').text()).toContain('No se reanuda solo');
    });

    it('1.3 NO deberia pintar el retardo en modo inmediato', () => {
      // 1. Arrange 📐: mostrarlo siempre invitaria a rellenar un campo que no
      //    se publica.
      const wrapper = mountComponent(nextNodeId());

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(wrapper.find('[data-test="delay-field"]').exists()).toBe(false);
    });

    it('1.4 NO deberia pintar el destinatario sin aviso activado', () => {
      // 1. Arrange 📐
      const wrapper = mountComponent(nextNodeId());

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(wrapper.find('[data-test="recipient-field"]').exists()).toBe(false);
    });
  });

  describe('2. Retardo', () => {
    it('2.1 deberia revelar el campo al elegir pausa con retardo', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = usePauseFlowStore(nodeId);

      // 2. Act ⚙️
      store.setPauseMode(PauseTriggerMode.DELAYED);
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="delay-field"]').exists()).toBe(true);
    });

    it('2.2 deberia traducir los segundos a minutos', async () => {
      // 1. Arrange 📐: el operador piensa en minutos; obligarle a dividir 900
      //    entre 60 mentalmente es como se cuelan los ceros de mas.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = usePauseFlowStore(nodeId);

      // 2. Act ⚙️
      store.setPauseMode(PauseTriggerMode.DELAYED);
      store.updateConfig({ delaySeconds: 300 });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.get('[data-test="delay-echo"]').text()).toContain('5 min');
    });

    it('2.3 deberia marcar el campo fuera de rango por encima del tope', async () => {
      // 1. Arrange 📐: la clase lleva el diagnostico al campo, que es donde el
      //    operador puede corregirlo.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = usePauseFlowStore(nodeId);

      // 2. Act ⚙️
      store.setPauseMode(PauseTriggerMode.DELAYED);
      store.updateConfig({ delaySeconds: MAX_PAUSE_DELAY_SECONDS + 1 });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.get('[data-test="delay-field"]').html()).toContain('pd-field--out-of-range');
    });

    it('2.4 deberia marcar el campo en rango con un valor valido', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = usePauseFlowStore(nodeId);

      // 2. Act ⚙️
      store.setPauseMode(PauseTriggerMode.DELAYED);
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.get('[data-test="delay-field"]').html()).toContain('pd-field--in-range');
    });
  });

  describe('3. Aviso por correo', () => {
    it('3.1 deberia revelar el destinatario al activar el aviso', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = usePauseFlowStore(nodeId);

      // 2. Act ⚙️
      store.updateConfig({ notifyOnPause: true });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="recipient-field"]').exists()).toBe(true);
    });

    it('3.2 deberia reflejar en el store lo que se escribe', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = usePauseFlowStore(nodeId);

      store.updateConfig({ notifyOnPause: true });
      await wrapper.vm.$nextTick();

      // 2. Act ⚙️
      await wrapper
        .get('[data-test="recipient-field"]')
        .findComponent(QSelect)
        .setValue([RECIPIENT]);

      // 3. Assert 🎯
      expect(store.config.notificationRecipients).toEqual([RECIPIENT]);
      expect(store.isConfigValid).toBe(true);
    });

    it('3.3 deberia admitir varias direcciones a la vez', async () => {
      // 1. Arrange 📐: el aviso de pausa espera a un EQUIPO, no a un buzon. Con
      //    un solo destinatario, una ausencia dejaba el flujo congelado sin que
      //    nadie se enterase.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = usePauseFlowStore(nodeId);
      const second = 'redaccion@unuware.com';

      store.updateConfig({ notifyOnPause: true });
      await wrapper.vm.$nextTick();

      // 2. Act ⚙️
      await wrapper
        .get('[data-test="recipient-field"]')
        .findComponent(QSelect)
        .setValue([RECIPIENT, second]);

      // 3. Assert 🎯
      expect(store.config.notificationRecipients).toEqual([RECIPIENT, second]);
      expect(store.toNodeParams().notificationRecipients).toEqual([RECIPIENT, second]);
      expect(store.isConfigValid).toBe(true);
    });

    it('3.4 deberia nombrar una a una las direcciones invalidas', async () => {
      // 1. Arrange 📐: un "hay un correo invalido" generico obliga a revisar
      //    los chips de uno en uno a ojo.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = usePauseFlowStore(nodeId);

      // 2. Act ⚙️
      store.updateConfig({
        notifyOnPause: true,
        notificationRecipients: [RECIPIENT, 'no-es-un-correo'],
      });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.get('[data-test="invalid-recipients"]').text()).toContain('no-es-un-correo');
      expect(store.isConfigValid).toBe(false);
    });
  });
});
