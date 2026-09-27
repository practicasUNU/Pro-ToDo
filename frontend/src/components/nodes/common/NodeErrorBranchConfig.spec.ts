// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO, como en los demas specs de componente: los de store no
// necesitan DOM y arrancan mas rapido sin el.
import { config, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  QBanner,
  QExpansionItem,
  QIcon,
  QInput,
  QItem,
  QItemLabel,
  QItemSection,
  QSelect,
  QToggle,
  Quasar,
} from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import NodeErrorBranchConfig from '@components/nodes/common/NodeErrorBranchConfig.vue';
import { useFlujoDraftStore } from '@stores/flujo-draft.store';

import { NodeType } from '@/types/pipeline';
import { SHARED_ALERT_NODE_ID } from '@/types/nodes/error-branch.types';

import type { WorkflowTemplateSummary } from '@/types/pipeline';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/workflow-templates.service', () => ({
  fetchWorkflowTemplates: vi.fn(),
}));
vi.mock('@services/workflows.service', () => ({
  createWorkflow: vi.fn(),
  fetchWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
}));
vi.mock('@services/node-catalog.service', () => ({ fetchNodeCatalog: vi.fn() }));
vi.mock('@services/nodes/trigger-imap.service', () => ({ checkImapConnection: vi.fn() }));
vi.mock('@services/nodes/parser-email.service', () => ({ checkParser: vi.fn() }));
vi.mock('@services/nodes/web-scraper.service', () => ({ checkScraper: vi.fn() }));
vi.mock('@services/nodes/template-mapper.service', () => ({
  fetchSelectableTemplates: vi.fn(),
  compilePreview: vi.fn(),
}));

const workflowTemplatesService = await import('@services/workflow-templates.service');
const fetchWorkflowTemplates = vi.mocked(workflowTemplatesService.fetchWorkflowTemplates);

const nodeCatalogService = await import('@services/node-catalog.service');
const fetchNodeCatalog = vi.mocked(nodeCatalogService.fetchNodeCatalog);

const TEMPLATE_ID = 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const PARSER_NODE_ID = 'nodo_parser';

const QUASAR_COMPONENTS = {
  QBanner,
  QExpansionItem,
  QIcon,
  QInput,
  QItem,
  QItemLabel,
  QItemSection,
  QSelect,
  QToggle,
};

/** Topologia sin nodo de IA: es el caso corriente. */
const buildTemplate = (topology: WorkflowTemplateSummary['topology']): WorkflowTemplateSummary => ({
  id: TEMPLATE_ID,
  name: 'Notiweb',
  description: null,
  active: true,
  topology,
});

const TOPOLOGY_SIN_IA: WorkflowTemplateSummary['topology'] = [
  { nodeId: 'trigger_imap', nodeType: NodeType.TRIGGER_IMAP, outputNamespace: 'raw_email' },
  { nodeId: PARSER_NODE_ID, nodeType: NodeType.PARSER_PRE_IA, outputNamespace: 'parsed_email' },
];

const TOPOLOGY_CON_IA: WorkflowTemplateSummary['topology'] = [
  ...TOPOLOGY_SIN_IA,
  { nodeId: 'nodo_ia', nodeType: NodeType.PROCESADOR_IA, outputNamespace: 'llm_response' },
];

/** Borrador con la topologia indicada ya elegida. */
const buildDraft = async (
  topology: WorkflowTemplateSummary['topology'] = TOPOLOGY_SIN_IA,
): Promise<ReturnType<typeof useFlujoDraftStore>> => {
  const draft = useFlujoDraftStore();
  fetchWorkflowTemplates.mockResolvedValue([buildTemplate(topology)]);
  fetchNodeCatalog.mockResolvedValue([]);
  await draft.loadAvailableTemplates();
  draft.selectTemplate(TEMPLATE_ID);

  return draft;
};

const mountPanel = (
  nodeId = PARSER_NODE_ID,
  nodeType: NodeType = NodeType.PARSER_PRE_IA,
): ReturnType<typeof mount> =>
  mount(NodeErrorBranchConfig, {
    props: { nodeId, nodeType },
    global: { plugins: [Quasar], components: QUASAR_COMPONENTS },
  });

/** El control de un campo, por el `data-test` de su CONTENEDOR. */
const selectByField = (wrapper: ReturnType<typeof mount>, field: string) =>
  wrapper.get(`[data-test="${field}"]`).findComponent(QSelect);

describe('NodeErrorBranchConfig · ruta de contingencia de un paso', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    config.global.plugins = [];
    vi.clearAllMocks();
  });

  describe('1. Estado inicial', () => {
    it('1.1 deberia montar el panel plegado y sin ruta', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      await buildDraft();
      const wrapper = mountPanel();

      // 3. Assert 🎯: es una seccion OPCIONAL. Sin ruta declarada un fallo
      //    detiene el flujo, que es el defecto correcto.
      expect(wrapper.find('[data-test="error-branch-panel"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="error-branch-trigger"]').exists()).toBe(false);
    });

    it('1.2 no deberia declarar nada solo por montarse', async () => {
      // 1. Arrange 📐
      const draft = await buildDraft();

      // 2. Act ⚙️
      mountPanel();

      // 3. Assert 🎯
      expect(draft.errorBranches).toEqual({});
    });
  });

  describe('2. Activacion', () => {
    it('2.1 deberia declarar la ruta por defecto al activar', async () => {
      // 1. Arrange 📐
      const draft = await buildDraft();
      const wrapper = mountPanel();

      // 2. Act ⚙️
      await wrapper
        .get('[data-test="error-branch-toggle"]')
        .findComponent(QToggle)
        .vm.$emit('update:modelValue', true);

      // 3. Assert 🎯: el defecto es el par siempre valido, y de ahi el operador
      //    afina. Arrancar sin accion dejaria una rama a medias que el backend
      //    rechaza al guardar.
      expect(draft.errorBranches[PARSER_NODE_ID]).toEqual({
        trigger: 'CUALQUIER_FALLO',
        action: 'ALERTA_SMTP',
      });
    });

    it('2.2 deberia retirarla al desactivar', async () => {
      // 1. Arrange 📐
      const draft = await buildDraft();
      draft.setErrorBranch(PARSER_NODE_ID, {
        trigger: 'CUALQUIER_FALLO',
        action: 'ALERTA_SMTP',
      });
      const wrapper = mountPanel();

      // 2. Act ⚙️
      await wrapper
        .get('[data-test="error-branch-toggle"]')
        .findComponent(QToggle)
        .vm.$emit('update:modelValue', false);

      // 3. Assert 🎯
      expect(draft.errorBranches[PARSER_NODE_ID]).toBeUndefined();
    });
  });

  describe('3. Selector de disparador', () => {
    it('3.1 deberia ofrecer el fallo por medios solo en el parser', async () => {
      // 1. Arrange 📐: solo el parser emite ERR_PARSER_UNEXTRACTABLE_MEDIA.
      //    Ofrecerlo en otro nodo crearia una rama muerta que ninguna regla del
      //    backend detecta.
      const draft = await buildDraft();
      draft.setErrorBranch(PARSER_NODE_ID, {
        trigger: 'CUALQUIER_FALLO',
        action: 'ALERTA_SMTP',
      });

      // 2. Act ⚙️
      const wrapper = mountPanel();

      // 3. Assert 🎯
      const options = selectByField(wrapper, 'error-branch-trigger').props('options') as {
        value: string;
      }[];

      expect(options.map((option) => option.value)).toEqual([
        'CUALQUIER_FALLO',
        'SIN_TEXTO_EXTRAIBLE',
      ]);
    });

    it('3.2 NO deberia ofrecerlo en un disparador', async () => {
      // 1. Arrange 📐
      const draft = await buildDraft();
      draft.setErrorBranch('trigger_imap', {
        trigger: 'CUALQUIER_FALLO',
        action: 'ALERTA_SMTP',
      });

      // 2. Act ⚙️
      const wrapper = mountPanel('trigger_imap', NodeType.TRIGGER_IMAP);

      // 3. Assert 🎯
      const options = selectByField(wrapper, 'error-branch-trigger').props('options') as {
        value: string;
      }[];

      expect(options.map((option) => option.value)).toEqual(['CUALQUIER_FALLO']);
    });
  });

  describe('4. Selector de accion', () => {
    it('4.1 NO deberia ofrecer la vision sin un nodo de IA en el flujo', async () => {
      // 1. Arrange 📐: un PROCESADOR_IA satelite chocaria con el del flujo en el
      //    namespace `llm_response` (regla 5 del validador), y ese tipo aun no
      //    tiene configurador con el que rellenar su prompt.
      const draft = await buildDraft(TOPOLOGY_SIN_IA);
      draft.setErrorBranch(PARSER_NODE_ID, {
        trigger: 'SIN_TEXTO_EXTRAIBLE',
        action: 'ALERTA_SMTP',
      });

      // 2. Act ⚙️
      const wrapper = mountPanel();

      // 3. Assert 🎯
      const options = selectByField(wrapper, 'error-branch-action').props('options') as {
        value: string;
      }[];

      expect(options.map((option) => option.value)).toEqual(['ALERTA_SMTP']);
      expect(wrapper.find('[data-test="no-vision-hint"]').exists()).toBe(true);
    });

    it('4.2 deberia ofrecerla con un nodo de IA y el disparador adecuado', async () => {
      // 1. Arrange 📐
      const draft = await buildDraft(TOPOLOGY_CON_IA);
      draft.setErrorBranch(PARSER_NODE_ID, {
        trigger: 'SIN_TEXTO_EXTRAIBLE',
        action: 'ALERTA_SMTP',
      });

      // 2. Act ⚙️
      const wrapper = mountPanel();

      // 3. Assert 🎯
      const options = selectByField(wrapper, 'error-branch-action').props('options') as {
        value: string;
      }[];

      expect(options.map((option) => option.value)).toEqual(['ALERTA_SMTP', 'VISION_IA']);
    });

    it('4.3 NO deberia ofrecer la vision ante cualquier fallo', async () => {
      // 1. Arrange 📐: un modelo con vision solo aporta algo cuando el correo
      //    trae imagen o PDF en vez de texto. Desviar ahi un fallo de
      //    configuracion seria pagar una inferencia por nada.
      const draft = await buildDraft(TOPOLOGY_CON_IA);
      draft.setErrorBranch(PARSER_NODE_ID, {
        trigger: 'CUALQUIER_FALLO',
        action: 'ALERTA_SMTP',
      });

      // 2. Act ⚙️
      const wrapper = mountPanel();

      // 3. Assert 🎯
      const options = selectByField(wrapper, 'error-branch-action').props('options') as {
        value: string;
      }[];

      expect(options.map((option) => option.value)).toEqual(['ALERTA_SMTP']);
    });

    it('4.4 deberia caer a la alerta si el disparador invalida la vision', async () => {
      // 1. Arrange 📐: dejar la vision seleccionada tras cambiar a "cualquier
      //    fallo" produciria una ruta que manda al nodo de IA un error de
      //    configuracion, que no es lo que nadie quiso decir.
      const draft = await buildDraft(TOPOLOGY_CON_IA);
      draft.setErrorBranch(PARSER_NODE_ID, {
        trigger: 'SIN_TEXTO_EXTRAIBLE',
        action: 'VISION_IA',
      });
      const wrapper = mountPanel();

      // 2. Act ⚙️
      await selectByField(wrapper, 'error-branch-trigger').vm.$emit(
        'update:modelValue',
        'CUALQUIER_FALLO',
      );

      // 3. Assert 🎯
      expect(draft.errorBranches[PARSER_NODE_ID]).toEqual({
        trigger: 'CUALQUIER_FALLO',
        action: 'ALERTA_SMTP',
      });
    });
  });

  describe('5. Configurador del nodo de alerta incrustado', () => {
    it('5.1 deberia aparecer cuando la rama provisiona el satelite', async () => {
      // 1. Arrange 📐: el operador declara la ruta y la parametriza en el mismo
      //    paso, sin buscar otro sitio donde poner los destinatarios.
      const draft = await buildDraft();
      draft.setErrorBranch(PARSER_NODE_ID, {
        trigger: 'CUALQUIER_FALLO',
        action: 'ALERTA_SMTP',
      });

      // 2. Act ⚙️
      const wrapper = mountPanel();

      // 3. Assert 🎯
      const embedded = wrapper.find('[data-test="embedded-alert-config"]');

      expect(embedded.exists()).toBe(true);
      expect(embedded.find(`[data-node-id="${SHARED_ALERT_NODE_ID}"]`).exists()).toBe(true);
    });

    it('5.2 NO deberia aparecer si el flujo ya trae un nodo de alerta', async () => {
      // 1. Arrange 📐: entonces la ruta apunta a ese, que se configura en su
      //    propio paso del asistente. Duplicar el formulario ofreceria dos sitios
      //    para la misma configuracion.
      const draft = await buildDraft([
        ...TOPOLOGY_SIN_IA,
        {
          nodeId: 'destino_correo',
          nodeType: NodeType.DESTINO_SMTP,
          outputNamespace: 'smtp_result',
        },
      ]);
      draft.setErrorBranch(PARSER_NODE_ID, {
        trigger: 'CUALQUIER_FALLO',
        action: 'ALERTA_SMTP',
      });

      // 2. Act ⚙️
      const wrapper = mountPanel();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="embedded-alert-config"]').exists()).toBe(false);
    });
  });
});
