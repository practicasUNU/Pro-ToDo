// @vitest-environment happy-dom
import { config, mount } from '@vue/test-utils';
import { QToggle, Quasar } from 'quasar';
import { beforeEach, describe, expect, it } from 'vitest';

import TriggerImapBaseParams from '@components/nodes/TriggerImapBaseParams.vue';

const NODE_ID = 'trigger_imap';

interface MountOptions {
  params?: Record<string, unknown>;
  locked?: boolean;
}

const mountControl = ({ params = {}, locked = false }: MountOptions = {}): ReturnType<
  typeof mount
> =>
  mount(TriggerImapBaseParams, {
    props: { params, nodeId: NODE_ID, locked },
    global: { plugins: [Quasar], components: { QToggle } },
  });

const toggleOf = (wrapper: ReturnType<typeof mount>) => wrapper.findComponent(QToggle);

describe('TriggerImapBaseParams · params base del disparador IMAP', () => {
  beforeEach(() => {
    config.global.plugins = [];
  });

  describe('1. Lectura defensiva del valor', () => {
    it('1.1 deberia reflejar el valor real de `params`', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = mountControl({ params: { includeAttachments: true } });

      // 3. Assert 🎯
      expect(toggleOf(wrapper).props('modelValue')).toBe(true);
    });

    it('1.2 NO deberia encenderse con un valor truthy que no sea `true`', () => {
      // 1. Arrange 📐: `configuracion_pipeline` es una columna jsonb que pudo
      //    escribirse por SQL directo, y la cadena 'false' es truthy en JS. Sin
      //    la comparacion estricta, el operador veria activada una ingesta que
      //    el backend interpreta como apagada.
      const wrapper = mountControl({ params: { includeAttachments: 'false' } });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(toggleOf(wrapper).props('modelValue')).toBe(false);
    });
  });

  describe('2. Bloqueo por la ruta de contingencia', () => {
    it('2.1 deberia deshabilitar el toggle con `locked`', () => {
      // 1. Arrange 📐: la ruta de vision lee los adjuntos de `raw_email`. Dejar
      //    apagarlos aqui convertiria el desvio en un respaldo mudo: pasaria la
      //    validacion del backend y llamaria al modelo sin nada que leer.
      const wrapper = mountControl({ params: { includeAttachments: true }, locked: true });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(toggleOf(wrapper).props('disable')).toBe(true);
    });

    it('2.2 deberia explicar POR QUE esta bloqueado', () => {
      // 1. Arrange 📐: un control apagado sin explicacion se lee como una
      //    averia, y el operador buscaria el fallo donde no esta.
      const wrapper = mountControl({ params: { includeAttachments: true }, locked: true });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(wrapper.get('[data-test="locked-hint"]').text()).toContain('vision IA');
    });

    it('2.3 deberia dejarlo editable sin bloqueo', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = mountControl({ params: { includeAttachments: true } });

      // 3. Assert 🎯
      expect(toggleOf(wrapper).props('disable')).toBe(false);
      expect(wrapper.find('[data-test="locked-hint"]').exists()).toBe(false);
    });
  });

  describe('3. Emision de cambios', () => {
    it('3.1 deberia publicar el objeto COMPLETO, no solo la clave que cambia', async () => {
      // 1. Arrange 📐: reconstruir `params` desde cero borraria en silencio lo
      //    que sembro otra version del editor, o un `mailbox` retocado a mano.
      const wrapper = mountControl({ params: { mailbox: 'ARCHIVE', includeAttachments: false } });

      // 2. Act ⚙️
      await toggleOf(wrapper).setValue(true);

      // 3. Assert 🎯
      expect(wrapper.emitted('update:params')?.[0]).toEqual([
        { mailbox: 'ARCHIVE', includeAttachments: true },
      ]);
    });
  });
});
