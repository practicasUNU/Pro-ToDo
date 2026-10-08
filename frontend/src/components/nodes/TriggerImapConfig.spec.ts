// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO, como en el resto de specs de componente: montar exige
// DOM, y los specs de store arrancan mas rapido sin el.
import { config, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  Notify,
  QBadge,
  QBtn,
  QCheckbox,
  QExpansionItem,
  QIcon,
  QInput,
  QSelect,
  QToggle,
  Quasar,
} from 'quasar';
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

const QUASAR_COMPONENTS = {
  QBadge,
  QBtn,
  QCheckbox,
  QExpansionItem,
  QIcon,
  QInput,
  QSelect,
  QToggle,
};

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

/** Selector del modo de coincidencia, por el `data-test` de su contenedor. */
const modeSelect = (wrapper: ReturnType<typeof mount>) =>
  wrapper.get('[data-test="subject-match-mode"]').findComponent(QSelect);

/** Campo asistido ("contiene" / "empieza por"), ausente en modo avanzado. */
const draftInput = (wrapper: ReturnType<typeof mount>) =>
  wrapper.get('[data-test="subject-match-draft"]').findComponent(QInput);

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

  describe('4. Modos asistidos de coincidencia', () => {
    it('4.1 deberia arrancar en "contiene texto" con el campo asistido a la vista', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = mountComponent(nextNodeId());

      // 3. Assert 🎯: la expresion regular deja de ser lo primero que ve el
      //    operador; queda relegada al acordeon de modo avanzado.
      expect(modeSelect(wrapper).props('modelValue')).toBe('CONTAINS');
      expect(draftInput(wrapper).props('modelValue')).toBe('');
    });

    it('4.2 deberia componer una alternancia desde palabras separadas por comas', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useTriggerImapStore(nodeId);

      // 2. Act ⚙️
      await draftInput(wrapper).setValue('licitacion, convocatoria');

      // 3. Assert 🎯: lo que se guarda sigue siendo un patron; el modo es solo
      //    la forma de componerlo sin teclear expresiones regulares.
      expect(store.config.subjectFilterRegex).toBe('(?:licitacion|convocatoria)');
    });

    it('4.3 deberia anclar el texto al cambiar a "empieza por"', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useTriggerImapStore(nodeId);

      await draftInput(wrapper).setValue('S_2026_');

      // 2. Act ⚙️
      await modeSelect(wrapper).setValue('STARTS_WITH');

      // 3. Assert 🎯
      expect(store.config.subjectFilterRegex).toBe('^S_2026_');
    });

    it('4.4 deberia abrir en modo avanzado un patron heredado que no sabe expresar', () => {
      // 1. Arrange 📐: un flujo guardado antes de que existieran los modos.
      const nodeId = nextNodeId();
      const store = useTriggerImapStore(nodeId);

      store.hydrateFromNode({ params: { subjectFilterRegex: '^S_2026_.*' } } as never);

      // 2. Act ⚙️
      const wrapper = mountComponent(nodeId);

      // 3. Assert 🎯: el modo no viaja en los `params`, se deduce de la forma.
      //    Lo que no encaja se conserva intacto en vez de perderse.
      expect(store.subjectMatchMode).toBe('ADVANCED');
      expect(regexInput(wrapper).props('modelValue')).toBe('^S_2026_.*');
      expect(wrapper.find('[data-test="subject-match-draft"]').exists()).toBe(false);
    });

    it('4.5 deberia reabrir en "empieza por" un patron que SI sabe expresar', () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const store = useTriggerImapStore(nodeId);

      store.hydrateFromNode({ params: { subjectFilterRegex: '^S_2026_' } } as never);

      // 2. Act ⚙️
      const wrapper = mountComponent(nodeId);

      // 3. Assert 🎯
      expect(store.subjectMatchMode).toBe('STARTS_WITH');
      expect(draftInput(wrapper).props('modelValue')).toBe('S_2026_');
    });

    it('4.6 no deberia reinterpretar como texto llano un patron escrito a mano', async () => {
      // 1. Arrange 📐: el operador escribe una expresion en el modo avanzado.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useTriggerImapStore(nodeId);

      await regexInput(wrapper).setValue('^S_2026_.*');
      expect(store.subjectMatchMode).toBe('ADVANCED');

      // 2. Act ⚙️: y pide volver a un modo asistido.
      store.setSubjectMatchMode('CONTAINS');

      // 3. Assert 🎯: la peticion se ignora porque el patron no es expresable.
      //    Aceptarla escaparia el texto a `\^S_2026_\.\*` y destruiria el
      //    filtro sin decir una palabra.
      expect(store.subjectMatchMode).toBe('ADVANCED');
      expect(store.config.subjectFilterRegex).toBe('^S_2026_.*');
    });
  });
});
