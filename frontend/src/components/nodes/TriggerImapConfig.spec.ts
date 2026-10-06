// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO, como en el resto de specs de componente: montar exige
// DOM, y los specs de store arrancan mas rapido sin el.
import { config, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { Notify, QBadge, QBtn, QCheckbox, QIcon, QInput, QToggle, Quasar } from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador. El
// filtro no dispara ninguna peticion, asi que el doble basta con existir.
vi.mock('@services/nodes/trigger-imap.service', () => ({
  checkImapConnection: vi.fn(),
}));

import TriggerImapConfig from '@components/nodes/TriggerImapConfig.vue';
import { useTriggerImapStore } from '@stores/nodes/trigger-imap.store';

/** `nodeId` unico por prueba: las definiciones de Pinia se memoizan por modulo. */
let nodeCounter = 0;
const nextNodeId = (): string => `trigger_imap_view_${(nodeCounter += 1)}`;

const QUASAR_COMPONENTS = { QBadge, QBtn, QCheckbox, QIcon, QInput, QToggle };

const mountComponent = (nodeId: string): ReturnType<typeof mount> =>
  mount(TriggerImapConfig, {
    props: { nodeId },
    global: { plugins: [[Quasar, { plugins: { Notify } }]], components: QUASAR_COMPONENTS },
  });

/**
 * El control del filtro, localizado por el `data-test` de su CONTENEDOR.
 *
 * Quasar derrama los atributos sobre un div interno, asi que marcar el propio
 * `q-input` no serviria para encontrarlo.
 */
const regexInput = (wrapper: ReturnType<typeof mount>) =>
  wrapper.get('[data-test="subject-filter-regex"]').findComponent(QInput);

describe('TriggerImapConfig · filtro de asunto por expresion regular', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    config.global.plugins = [];
  });

  describe('1. Montaje', () => {
    it('1.1 deberia pintar el campo vacio, sin filtro por defecto', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = mountComponent(nextNodeId());

      // 3. Assert 🎯: el filtro es opt-in; un valor sugerido descartaria correos
      //    en un flujo que nadie configuro para eso.
      expect(regexInput(wrapper).props('modelValue')).toBe('');
    });
  });

  describe('2. Enlace con el store', () => {
    it('2.1 deberia publicar el patron escrito sin pasar por patchConfig', async () => {
      // 1. Arrange 📐: el store arranca con la conexion dada por verificada
      //    para poder comprobar que el filtro NO la invalida.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useTriggerImapStore(nodeId);

      store.$patch({ connectionVerified: true });

      // 2. Act ⚙️
      await regexInput(wrapper).setValue('^S_2026_.*');

      // 3. Assert 🎯: va por `patchFilters`, porque cambiar a que asuntos se
      //    atiende no afecta a las credenciales ya probadas.
      expect(store.config.subjectFilterRegex).toBe('^S_2026_.*');
      expect(store.connectionVerified).toBe(true);
    });

    it('2.2 deberia reflejar un patron ya guardado al rehidratar el nodo', () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const store = useTriggerImapStore(nodeId);

      store.patchFilters({ subjectFilterRegex: '^Notiweb' });

      // 2. Act ⚙️
      const wrapper = mountComponent(nodeId);

      // 3. Assert 🎯
      expect(regexInput(wrapper).props('modelValue')).toBe('^Notiweb');
    });
  });

  describe('3. Bloqueo del paso ante un patron invalido', () => {
    it('3.1 deberia invalidar el nodo cuando el patron no compila', async () => {
      // 1. Arrange 📐: nodo por lo demas completo y con conexion resuelta, para
      //    que lo unico que pueda invalidarlo sea el patron.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useTriggerImapStore(nodeId);

      store.patchConfig({
        host: 'imap.unuware.com',
        user: 'notiweb@unuware.com',
        passwordEnvKey: 'IMAP_PASSWORD',
      });
      store.$patch({ connectionVerified: true });
      expect(store.isConfigValid).toBe(true);

      // 2. Act ⚙️
      await regexInput(wrapper).setValue('([');

      // 3. Assert 🎯: sin esto el asistente dejaria avanzar y el 400 del backend
      //    apareceria tres pasos mas tarde, lejos del campo que lo causo.
      expect(store.hasValidFields).toBe(false);
      expect(store.isConfigValid).toBe(false);
    });

    it('3.2 deberia volver a validar en cuanto el patron se corrige', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useTriggerImapStore(nodeId);

      store.patchConfig({
        host: 'imap.unuware.com',
        user: 'notiweb@unuware.com',
        passwordEnvKey: 'IMAP_PASSWORD',
      });
      store.$patch({ connectionVerified: true });
      await regexInput(wrapper).setValue('([');

      // 2. Act ⚙️
      await regexInput(wrapper).setValue('^S_2026_');

      // 3. Assert 🎯: el bloqueo es reversible, no un estado pegajoso.
      expect(store.isConfigValid).toBe(true);
    });

    it('3.3 NO deberia bloquear por un campo vacio', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useTriggerImapStore(nodeId);

      store.patchConfig({
        host: 'imap.unuware.com',
        user: 'notiweb@unuware.com',
        passwordEnvKey: 'IMAP_PASSWORD',
      });
      store.$patch({ connectionVerified: true });

      // 2. Act ⚙️: borrar el filtro es la forma de desactivarlo.
      await regexInput(wrapper).setValue('');

      // 3. Assert 🎯
      expect(store.isConfigValid).toBe(true);
    });
  });
});
