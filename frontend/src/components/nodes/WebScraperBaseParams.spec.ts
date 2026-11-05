// @vitest-environment happy-dom
import { config, mount } from '@vue/test-utils';
import { QToggle, Quasar } from 'quasar';
import { beforeEach, describe, expect, it } from 'vitest';

import WebScraperBaseParams from '@components/nodes/WebScraperBaseParams.vue';

const NODE_ID = 'nodo_extractor';

interface MountOptions {
  params?: Record<string, unknown>;
  locked?: boolean;
}

const mountControl = ({ params = {}, locked = false }: MountOptions = {}): ReturnType<
  typeof mount
> =>
  mount(WebScraperBaseParams, {
    props: { params, nodeId: NODE_ID, locked },
    global: { plugins: [Quasar], components: { QToggle } },
  });

const toggleOf = (wrapper: ReturnType<typeof mount>) => wrapper.findComponent(QToggle);

describe('WebScraperBaseParams · params base del extractor web', () => {
  beforeEach(() => {
    config.global.plugins = [];
  });

  describe('1. Lectura defensiva del valor', () => {
    it('1.1 deberia nacer ENCENDIDO sin la clave, por ser un opt-out', () => {
      // 1. Arrange 📐 + 2. Act ⚙️: el inverso del control de IMAP, donde la
      //    ausencia significa apagado. Aqui el defecto del backend es `true`, y
      //    mostrarlo apagado mentiria sobre lo que el nodo hara al ejecutarse.
      const wrapper = mountControl();

      // 3. Assert 🎯
      expect(toggleOf(wrapper).props('modelValue')).toBe(true);
    });

    it('1.2 deberia apagarse solo con el `false` expreso', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = mountControl({ params: { skipIfEmpty: false } });

      // 3. Assert 🎯
      expect(toggleOf(wrapper).props('modelValue')).toBe(false);
    });

    it('1.3 NO deberia apagarse con la cadena "false" de un jsonb a mano', () => {
      // 1. Arrange 📐: `configuracion_pipeline` pudo escribirse por SQL directo.
      const wrapper = mountControl({ params: { skipIfEmpty: 'false' } });

      // 2. Act ⚙️ + 3. Assert 🎯: la cadena no es el booleano `false`, asi que
      //    el backend la rechaza; el control no finge que la entiende.
      expect(toggleOf(wrapper).props('modelValue')).toBe(true);
    });
  });

  describe('2. Contrato de emision', () => {
    it('2.1 deberia emitir el objeto COMPLETO y no solo la clave que cambia', async () => {
      // 1. Arrange 📐: el nodo trae un `targetUrl` que este control no gestiona.
      const wrapper = mountControl({
        params: { targetUrl: '{{parsed_email.extracted_urls[0]}}', timeoutMs: 30_000 },
      });

      // 2. Act ⚙️
      await toggleOf(wrapper).vm.$emit('update:model-value', false);

      // 3. Assert 🎯: reconstruir `params` desde cero borraria en silencio lo
      //    que sembro otra version del editor al accionar un interruptor.
      expect(wrapper.emitted('update:params')?.[0]?.[0]).toEqual({
        targetUrl: '{{parsed_email.extracted_urls[0]}}',
        timeoutMs: 30_000,
        skipIfEmpty: false,
      });
    });

    it('2.2 deberia emitir el encendido explicito', async () => {
      // 1. Arrange 📐
      const wrapper = mountControl({ params: { skipIfEmpty: false } });

      // 2. Act ⚙️
      await toggleOf(wrapper).vm.$emit('update:model-value', true);

      // 3. Assert 🎯: la clave viaja ESCRITA. La regla 8 del backend solo exime
      //    al nodo si la encuentra literal en el esquema.
      expect(wrapper.emitted('update:params')?.[0]?.[0]).toEqual({ skipIfEmpty: true });
    });
  });

  describe('3. Bloqueo por topologia', () => {
    it('3.1 deberia deshabilitar el control y explicar por que', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = mountControl({ locked: true });

      // 3. Assert 🎯: un control apagado sin explicacion se lee como averia.
      expect(toggleOf(wrapper).props('disable')).toBe(true);
      expect(wrapper.find('[data-test="locked-hint"]').exists()).toBe(true);
    });

    it('3.2 no deberia mostrar la pista cuando es editable', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = mountControl();

      // 3. Assert 🎯
      expect(toggleOf(wrapper).props('disable')).toBe(false);
      expect(wrapper.find('[data-test="locked-hint"]').exists()).toBe(false);
    });
  });
});
