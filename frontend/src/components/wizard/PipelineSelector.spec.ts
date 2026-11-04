// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  QBadge,
  QBtn,
  QCard,
  QCardActions,
  QCardSection,
  QIcon,
  QInput,
  QSpace,
  QSpinner,
  Quasar,
} from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PipelineSelector from '@components/wizard/PipelineSelector.vue';

import { NodeType } from '@/types/pipeline';
import { AUDIT_FIXTURE } from '@/testing/audit.fixture';

import type { WorkflowTemplateSummary } from '@/types/pipeline';

// `@boot/axios` importa `#q-app`, que no resuelve fuera del build de Quasar.
vi.mock('@services/node-catalog.service', () => ({
  fetchNodeCatalog: vi.fn().mockResolvedValue([]),
}));

/** Plantilla minima del listado, con la topologia que pinta la tarjeta. */
const template = (
  id: string,
  name: string,
  description: string | null,
  types: NodeType[],
): WorkflowTemplateSummary => ({
  ...AUDIT_FIXTURE,
  id,
  name,
  description,
  active: true,
  topology: types.map((nodeType, index) => ({
    nodeId: `n${index}`,
    nodeType,
    outputNamespace: `ns${index}`,
  })),
});

const TEMPLATES: WorkflowTemplateSummary[] = [
  template(
    't-notiweb',
    'Maestro · Notiweb',
    '[wf-notiweb-madridmasd] Redaccion de una noticia institucional.',
    [NodeType.TRIGGER_IMAP, NodeType.PROCESADOR_IA, NodeType.DESTINO_ACENS],
  ),
  template(
    't-apertura',
    'Maestro · Apertura de licitación',
    '[wf-licitacion-abrir] Alta de una convocatoria.',
    [NodeType.TRIGGER_IMAP, NodeType.DESTINO_DRUPAL],
  ),
  template('t-libre', 'Borrador sin descripcion', null, [NodeType.TRIGGER_CRON]),
];

const mountSelector = (
  templates: WorkflowTemplateSummary[] = TEMPLATES,
): ReturnType<typeof mount> =>
  mount(PipelineSelector, {
    props: { templates, isLoading: false },
    global: {
      plugins: [Quasar],
      components: {
        QBadge,
        QBtn,
        QCard,
        QCardActions,
        QCardSection,
        QIcon,
        QInput,
        QSpace,
        QSpinner,
      },
    },
  });

/** Nombres de las tarjetas pintadas, en orden. */
const shownNames = (wrapper: ReturnType<typeof mount>): string[] =>
  wrapper.findAll('.pd-pipeline-card .pd-h2').map((node) => node.text());

/** Escribe en el buscador por el componente: el data-test va al input nativo. */
const search = async (wrapper: ReturnType<typeof mount>, text: string): Promise<void> => {
  wrapper.findComponent(QInput).vm.$emit('update:modelValue', text);
  await flushPromises();
};

describe('PipelineSelector · buscador de plantillas', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('1. deberia mostrar todas las plantillas sin busqueda', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const wrapper = mountSelector();
    await flushPromises();

    // 3. Assert 🎯
    expect(shownNames(wrapper)).toHaveLength(3);
    expect(wrapper.find('[data-test="template-search-empty"]').exists()).toBe(false);
  });

  it('2. deberia filtrar por nombre sin distinguir mayusculas', async () => {
    // 1. Arrange 📐
    const wrapper = mountSelector();

    // 2. Act ⚙️
    await search(wrapper, '  NOTIWEB ');

    // 3. Assert 🎯
    expect(shownNames(wrapper)).toEqual(['Maestro · Notiweb']);
  });

  it('3. deberia encontrar por el slug de la descripcion y por el rotulo de un nodo', async () => {
    // 1. Arrange 📐
    const wrapper = mountSelector();

    // 2. Act ⚙️ + 3. Assert 🎯: el slug es el "codigo" de una plantilla de flujo.
    await search(wrapper, 'wf-licitacion-abrir');
    expect(shownNames(wrapper)).toEqual(['Maestro · Apertura de licitación']);

    await search(wrapper, 'acens');
    expect(shownNames(wrapper)).toEqual(['Maestro · Notiweb']);
  });

  it('4. deberia mostrar el estado vacio propio y limpiar la busqueda', async () => {
    // 1. Arrange 📐
    const wrapper = mountSelector();

    // 2. Act ⚙️
    await search(wrapper, 'inexistente');

    // 3. Assert 🎯
    const empty = wrapper.find('[data-test="template-search-empty"]');
    expect(empty.exists()).toBe(true);
    expect(empty.text()).toContain('inexistente');
    expect(shownNames(wrapper)).toEqual([]);

    await wrapper.get('[data-test="template-search-reset"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-test="template-search-empty"]').exists()).toBe(false);
    expect(shownNames(wrapper)).toHaveLength(3);
  });

  it('5. deberia ofrecer el boton de limpiar solo con texto escrito', async () => {
    // 1. Arrange 📐
    const wrapper = mountSelector();
    expect(wrapper.find('[data-test="template-search-clear"]').exists()).toBe(false);

    // 2. Act ⚙️
    await search(wrapper, 'notiweb');

    // 3. Assert 🎯
    expect(wrapper.find('[data-test="template-search-clear"]').exists()).toBe(true);
  });

  it('6. deberia conservar el estado "sin plantillas" cuando no hay ninguna', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const wrapper = mountSelector([]);
    await flushPromises();

    // 3. Assert 🎯: sin plantillas no hay buscador que ofrecer.
    expect(wrapper.text()).toContain('No hay plantillas disponibles');
    expect(wrapper.findComponent(QInput).exists()).toBe(false);
  });
});
