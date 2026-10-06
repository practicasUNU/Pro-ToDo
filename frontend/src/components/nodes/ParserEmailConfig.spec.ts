// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO, como en el resto de specs de componente: montar exige
// DOM, y los specs de store arrancan mas rapido sin el.
import { config, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  Notify,
  QBanner,
  QBtn,
  QCard,
  QIcon,
  QInput,
  QSelect,
  QToggle,
  Quasar,
} from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador. Nada
// de lo que se prueba aqui llega al banco de pruebas.
vi.mock('@services/nodes/parser-email.service', () => ({
  checkParser: vi.fn(),
}));

import ParserEmailConfig from '@components/nodes/ParserEmailConfig.vue';
import {
  EXCLUDABLE_EXTENSION_PRESETS,
  useParserEmailStore,
} from '@stores/nodes/parser-email.store';

/** `nodeId` unico por prueba: las definiciones de Pinia se memoizan por modulo. */
let nodeCounter = 0;
const nextNodeId = (): string => `parser_email_view_${(nodeCounter += 1)}`;

const QUASAR_COMPONENTS = { QBanner, QBtn, QCard, QIcon, QInput, QSelect, QToggle };

const mountComponent = (nodeId: string): ReturnType<typeof mount> =>
  mount(ParserEmailConfig, {
    props: { nodeId },
    global: { plugins: [[Quasar, { plugins: { Notify } }]], components: QUASAR_COMPONENTS },
  });

/**
 * Los dos controles nuevos, localizados por el `data-test` de su CONTENEDOR.
 *
 * Quasar derrama los atributos sobre un div interno, asi que marcar el propio
 * componente no serviria para encontrarlo.
 */
const skipToggle = (wrapper: ReturnType<typeof mount>) =>
  wrapper.get('[data-test="skip-document-extraction"]').findComponent(QToggle);

const extensionsSelect = (wrapper: ReturnType<typeof mount>) =>
  wrapper.get('[data-test="excluded-extensions"]').findComponent(QSelect);

describe('ParserEmailConfig · exclusion de documentos adjuntos', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    config.global.plugins = [];
  });

  describe('1. Montaje', () => {
    it('1.1 deberia pintar ambos controles en su defecto permisivo', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = mountComponent(nextNodeId());

      // 3. Assert 🎯: por defecto se extrae de todo, igual que el backend. Un
      //    defecto distinto cambiaria el payload de los flujos ya guardados.
      expect(skipToggle(wrapper).props('modelValue')).toBe(false);
      expect(extensionsSelect(wrapper).props('modelValue')).toEqual([]);
    });

    it('1.2 deberia ofrecer las extensiones preseleccionadas como atajo', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = mountComponent(nextNodeId());

      // 3. Assert 🎯: sugerencias, no lista cerrada; el selector admite valores
      //    nuevos porque este fichero no puede fijar el catalogo de formatos
      //    que una organizacion decide no leer.
      expect(extensionsSelect(wrapper).props('options')).toEqual(
        EXCLUDABLE_EXTENSION_PRESETS,
      );
      expect(extensionsSelect(wrapper).props('newValueMode')).toBe('add-unique');
    });
  });

  describe('2. Enlace con el store', () => {
    it('2.1 deberia publicar el interruptor de omision en el store', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useParserEmailStore(nodeId);

      // 2. Act ⚙️
      await skipToggle(wrapper).setValue(true);

      // 3. Assert 🎯
      expect(store.config.skipDocumentExtraction).toBe(true);
      expect(store.toNodeParams()).toMatchObject({ skipDocumentExtraction: true });
    });

    it('2.2 deberia normalizar las extensiones tecleadas a mano', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useParserEmailStore(nodeId);

      // 2. Act ⚙️: lo que teclea el operador, tal cual.
      await extensionsSelect(wrapper).setValue(['PPTX', '.Ppt', 'pptx']);

      // 3. Assert 🎯: sin normalizar, `add-unique` guardaria las tres como
      //    entradas distintas y ninguna excluiria el fichero que se queria
      //    excluir, porque el backend compara contra la forma canonica.
      expect(store.config.excludedExtensions).toEqual(['.pptx', '.ppt']);
    });

    it('2.3 deberia deshabilitar la lista cuando ya se omiten todos', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      await skipToggle(wrapper).setValue(true);

      // 3. Assert 🎯: una lista de excepciones sobre un "ninguno" no excluye
      //    nada y solo confunde.
      expect(extensionsSelect(wrapper).props('disable')).toBe(true);
    });

    it('2.4 NO deberia invalidar el nodo por ninguna de las dos opciones', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useParserEmailStore(nodeId);

      // 2. Act ⚙️
      await skipToggle(wrapper).setValue(true);
      await extensionsSelect(wrapper).setValue(['.zip']);

      // 3. Assert 🎯: `isConfigValid` solo mira el umbral de cuerpo util; estas
      //    dos son siempre validas, incluso vacias.
      expect(store.isConfigValid).toBe(true);
    });
  });
});
