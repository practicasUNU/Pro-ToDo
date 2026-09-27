// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO, igual que en `WebScraperConfig.spec.ts`: los specs de
// store no necesitan DOM y arrancan mas rapido sin el.
import { config, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { QBanner, QIcon, QInput, QSelect, Quasar } from 'quasar';
import { beforeEach, describe, expect, it } from 'vitest';

import SmtpAlertConfig from '@components/nodes/SmtpAlertConfig.vue';
import { useSmtpAlertStore } from '@stores/nodes/smtp-alert.store';

import { DEFAULT_ALERT_SUBJECT } from '@/types/nodes/smtp-alert.types';

const RECIPIENT = 'guardia@unuware.com';

/** `nodeId` unico por prueba: las definiciones de Pinia se memoizan por modulo. */
let nodeCounter = 0;
const nextNodeId = (): string => `smtp_alert_view_${(nodeCounter += 1)}`;

const QUASAR_COMPONENTS = { QBanner, QIcon, QInput, QSelect };

const mountComponent = (nodeId: string): ReturnType<typeof mount> =>
  mount(SmtpAlertConfig, {
    props: { nodeId },
    global: { plugins: [Quasar], components: QUASAR_COMPONENTS },
  });

/**
 * El control de un campo, localizado por el `data-test` de su CONTENEDOR.
 *
 * Quasar derrama los atributos sobre un div interno, asi que marcar el propio
 * `q-select` no serviria para encontrarlo.
 */
const selectByField = (wrapper: ReturnType<typeof mount>, field: string) =>
  wrapper.get(`[data-test="${field}"]`).findComponent(QSelect);

describe('SmtpAlertConfig · configurador del nodo DESTINO_SMTP', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    config.global.plugins = [];
  });

  describe('1. Montaje', () => {
    it('1.1 deberia pintar los cuatro campos configurables', () => {
      // 1. Arrange 📐 + 2. Act ⚙️: `use-chips` no se usaba en ningun otro sitio
      //    del proyecto, y un selector que revienta al renderizar no lo detecta
      //    `vue-tsc`.
      const wrapper = mountComponent(nextNodeId());

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="recipients-field"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="cc-field"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="subject-field"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="custom-message-field"]').exists()).toBe(true);
    });

    it('1.2 deberia mostrar el asunto por defecto ya escrito', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = mountComponent(nextNodeId());

      // 3. Assert 🎯
      const subject = wrapper.get('[data-test="subject-field"]').findComponent(QInput);

      expect(subject.props('modelValue')).toBe(DEFAULT_ALERT_SUBJECT);
    });

    it('1.3 deberia pintar la vista previa de la carta', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = mountComponent(nextNodeId());

      // 3. Assert 🎯: es maqueta ESTRUCTURAL, no replica de la carta real.
      const preview = wrapper.get('[data-test="letter-preview"]');

      expect(preview.text()).toContain('Diagnostico tecnico');
      expect(preview.text()).toContain('Aqui se incrustara la nota');
    });
  });

  describe('2. Enlace con el store', () => {
    it('2.1 deberia reflejar la nota en la vista previa al escribirla', () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useSmtpAlertStore(nodeId);

      // 2. Act ⚙️
      store.updateConfig({ customMessage: 'Llamar al movil de guardia.' });

      // 3. Assert 🎯: es lo que el operador necesita saber —donde cae su nota—,
      //    y por eso la maqueta no es estatica del todo.
      return wrapper.vm.$nextTick().then(() => {
        expect(wrapper.get('[data-test="letter-preview"]').text()).toContain(
          'Llamar al movil de guardia.',
        );
      });
    });

    it('2.2 deberia recoger un correo tecleado sin confirmar con Enter', async () => {
      // 1. Arrange 📐: la pieza critica del campo, aprendida del selector de zona
      //    horaria del cron. `update:model-value` solo se emite al confirmar, asi
      //    que sin `@input-value` un correo escrito y no convertido en chip se
      //    perderia al pulsar Guardar mientras la pantalla lo sigue mostrando.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useSmtpAlertStore(nodeId);

      // 2. Act ⚙️
      await selectByField(wrapper, 'recipients-field').vm.$emit('input-value', RECIPIENT);

      // 3. Assert 🎯
      expect(store.config.to).toEqual([RECIPIENT]);
      expect(store.isConfigValid).toBe(true);
    });

    it('2.3 no deberia duplicar un destinatario ya presente', async () => {
      // 1. Arrange 📐: QSelect emite `input-value` mientras se teclea, asi que el
      //    manejador se invoca muchas veces con prefijos del mismo texto.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useSmtpAlertStore(nodeId);
      const recipients = selectByField(wrapper, 'recipients-field');

      // 2. Act ⚙️
      await recipients.vm.$emit('input-value', RECIPIENT);
      await recipients.vm.$emit('input-value', RECIPIENT);

      // 3. Assert 🎯
      expect(store.config.to).toEqual([RECIPIENT]);
    });

    it('2.4 deberia ignorar una entrada en blanco', async () => {
      // 1. Arrange 📐: QSelect emite la cadena vacia al abrir y al limpiar el
      //    campo; anadirla dejaria un chip vacio imposible de leer.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useSmtpAlertStore(nodeId);

      // 2. Act ⚙️
      await selectByField(wrapper, 'recipients-field').vm.$emit('input-value', '   ');

      // 3. Assert 🎯
      expect(store.config.to).toEqual([]);
    });
  });

  describe('3. Aviso de direcciones invalidas', () => {
    it('3.1 deberia nombrarlas una a una', async () => {
      // 1. Arrange 📐: con chips, decir "hay un correo mal" obliga al operador a
      //    revisarlos todos a ojo.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useSmtpAlertStore(nodeId);

      // 2. Act ⚙️
      store.updateConfig({ to: [RECIPIENT, 'roto'], cc: ['tambien@roto'] });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      const banner = wrapper.get('[data-test="invalid-recipients"]');

      expect(banner.text()).toContain('roto, tambien@roto');
    });

    it('3.2 no deberia aparecer con todo correcto', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useSmtpAlertStore(nodeId);

      // 2. Act ⚙️
      store.updateConfig({ to: [RECIPIENT] });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="invalid-recipients"]').exists()).toBe(false);
    });
  });
});
