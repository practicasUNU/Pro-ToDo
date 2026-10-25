// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO, igual que en los demas configuradores: los specs de
// store no necesitan DOM y arrancan mas rapido sin el.
import { config, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { QBadge, QBtnToggle, QChip, QIcon, QInput, QSelect, QSpace, Quasar } from 'quasar';
import { beforeEach, describe, expect, it } from 'vitest';

import TriggerCronConfig from '@components/nodes/TriggerCronConfig.vue';
import { useTriggerCronStore } from '@stores/nodes/trigger-cron.store';

/** `nodeId` unico por prueba: las definiciones de Pinia se memoizan por modulo. */
let nodeCounter = 0;
const nextNodeId = (): string => `trigger_cron_view_${(nodeCounter += 1)}`;

const QUASAR_COMPONENTS = { QBadge, QBtnToggle, QChip, QIcon, QInput, QSelect, QSpace };

const mountComponent = (nodeId: string): ReturnType<typeof mount> =>
  mount(TriggerCronConfig, {
    props: { nodeId },
    global: { plugins: [Quasar], components: QUASAR_COMPONENTS },
  });

describe('TriggerCronConfig · configurador del nodo TRIGGER_CRON', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    config.global.plugins = [];
  });

  describe('1. Modo asistido por defecto', () => {
    it('1.1 deberia abrir un nodo nuevo en el asistente, no en la expresion', () => {
      // 1. Arrange 📐: teclear sintaxis cron no deberia ser el precio de
      //    sondear cada cuarto de hora, que es el caso corriente.
      const wrapper = mountComponent(nextNodeId());

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(wrapper.find('[data-test="interval-field"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="expression-field"]').exists()).toBe(false);
    });

    it('1.2 deberia escribir la expresion del intervalo elegido', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useTriggerCronStore(nodeId);

      // 2. Act ⚙️
      await wrapper
        .get('[data-test="interval-field"]')
        .findComponent(QSelect)
        .setValue('*/15 * * * *');

      // 3. Assert 🎯: el asistente produce una expresion valida de verdad, no
      //    una etiqueta que haya que traducir despues.
      expect(store.config.cronExpression).toBe('*/15 * * * *');
      expect(store.isConfigValid).toBe(true);
      expect(store.toNodeParams()).toEqual({
        cronExpression: '*/15 * * * *',
        timeZone: 'Europe/Madrid',
      });
    });
  });

  describe('2. Modo manual', () => {
    it('2.1 deberia mostrar el campo de expresion al conmutar', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useTriggerCronStore(nodeId);

      // 2. Act ⚙️
      store.setScheduleMode('ADVANCED');
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="expression-field"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="interval-field"]').exists()).toBe(false);
    });

    it('2.2 NO deberia reescribir una expresion afinada a mano al volver al asistente', async () => {
      // 1. Arrange 📐: es la garantia que hace seguro el conmutador. Si volver
      //    al asistente normalizase la expresion, una programacion ajustada se
      //    perderia en silencio al mirarla.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useTriggerCronStore(nodeId);

      store.setScheduleMode('ADVANCED');
      store.patchConfig({ cronExpression: '0 9 * * 1-5' });
      await wrapper.vm.$nextTick();

      // 2. Act ⚙️
      store.setScheduleMode('SIMPLE');
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(store.config.cronExpression).toBe('0 9 * * 1-5');
    });
  });

  describe('3. Deduccion del modo al hidratar', () => {
    it('3.1 deberia abrir en el asistente un nodo guardado con un intervalo', async () => {
      // 1. Arrange 📐: el modo NO se persiste —el DTO valida con
      //    `forbidNonWhitelisted`— asi que se deduce de la forma guardada.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useTriggerCronStore(nodeId);

      // 2. Act ⚙️
      store.hydrateFromNode({
        nodeId: 'cron',
        nodeType: 'TRIGGER_CRON',
        params: { cronExpression: '*/30 * * * *', timeZone: 'Europe/Madrid' },
      } as never);
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(store.scheduleMode).toBe('SIMPLE');
      expect(wrapper.find('[data-test="interval-field"]').exists()).toBe(true);
    });

    it('3.2 deberia abrir en manual un nodo cuya expresion no es un intervalo', async () => {
      // 1. Arrange 📐: un flujo heredado no puede quedarse sin su programacion
      //    ni verla sustituida por el intervalo mas parecido.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useTriggerCronStore(nodeId);

      // 2. Act ⚙️
      store.hydrateFromNode({
        nodeId: 'cron',
        nodeType: 'TRIGGER_CRON',
        params: { cronExpression: '30 8 * * 1', timeZone: 'Europe/Madrid' },
      } as never);
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(store.scheduleMode).toBe('ADVANCED');
      expect(wrapper.find('[data-test="expression-field"]').exists()).toBe(true);
      expect(store.config.cronExpression).toBe('30 8 * * 1');
    });
  });
});
