// @vitest-environment happy-dom
import { config, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { QBadge, QBtn, QIcon, QSpace, Quasar } from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import NodeBranchCard from '@components/nodes/common/NodeBranchCard.vue';
import { useFlujoDraftStore } from '@stores/flujo-draft.store';

import { NodeType } from '@/types/pipeline';
import { MULTIMODAL_FALLBACK_CODE, SHARED_ALERT_NODE_ID } from '@/types/nodes/error-branch.types';

import type { WorkflowTemplateDetail, WorkflowTemplateSummary } from '@/types/pipeline';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/workflow-templates.service', () => ({
  fetchWorkflowTemplates: vi.fn(),
  fetchWorkflowTemplate: vi.fn(),
}));
vi.mock('@services/workflows.service', () => ({
  createWorkflow: vi.fn(),
  fetchWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
}));
vi.mock('@services/node-catalog.service', () => ({ fetchNodeCatalog: vi.fn() }));
vi.mock('@services/ai-prompt-templates.service', () => ({
  fetchAiPromptTemplates: vi.fn(),
  fetchAiPromptTemplateById: vi.fn(),
}));
vi.mock('@services/nodes/trigger-imap.service', () => ({ checkImapConnection: vi.fn() }));
vi.mock('@services/nodes/parser-email.service', () => ({ checkParser: vi.fn() }));
vi.mock('@services/nodes/web-scraper.service', () => ({ checkScraper: vi.fn() }));
vi.mock('@services/nodes/template-mapper.service', () => ({
  fetchSelectableTemplates: vi.fn(),
  compilePreview: vi.fn(),
}));

const workflowTemplatesService = await import('@services/workflow-templates.service');
const fetchWorkflowTemplates = vi.mocked(workflowTemplatesService.fetchWorkflowTemplates);
const fetchWorkflowTemplate = vi.mocked(workflowTemplatesService.fetchWorkflowTemplate);

const nodeCatalogService = await import('@services/node-catalog.service');
const fetchNodeCatalog = vi.mocked(nodeCatalogService.fetchNodeCatalog);

const TEMPLATE_ID = 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const PARSER_NODE_ID = 'nodo_parser';
const IA_NODE_ID = 'nodo_ia';

const QUASAR_COMPONENTS = { QBadge, QBtn, QIcon, QSpace };

/** Flujo de tres pasos: disparador, parser y nodo de IA. */
const TOPOLOGY: WorkflowTemplateSummary['topology'] = [
  { nodeId: 'trigger_imap', nodeType: NodeType.TRIGGER_IMAP, outputNamespace: 'raw_email' },
  { nodeId: PARSER_NODE_ID, nodeType: NodeType.PARSER_PRE_IA, outputNamespace: 'parsed_email' },
  { nodeId: IA_NODE_ID, nodeType: NodeType.PROCESADOR_IA, outputNamespace: 'llm_response' },
];

const TEMPLATE: WorkflowTemplateSummary = {
  id: TEMPLATE_ID,
  name: 'Notiweb',
  description: null,
  active: true,
  topology: TOPOLOGY,
};

/** Ruta selectiva de vision: la unica que atrapa el codigo del parser. */
const VISION_ROUTE = { targetNode: IA_NODE_ID, catchErrors: [MULTIMODAL_FALLBACK_CODE] };

/**
 * Detalle de la plantilla con la ruta que la tarjeta representa.
 *
 * `selectTemplate` pide el DETALLE para hidratar las ramas: el resumen solo trae
 * el camino activo, sin `onErrorStep` ni el nodo satelite que lo atiende.
 *
 * @param route Ruta declarada por el parser.
 */
const buildDetail = (route: unknown): WorkflowTemplateDetail => {
  const nodes: Record<string, unknown> = Object.fromEntries(
    TOPOLOGY.map((step, index) => [
      step.nodeId,
      {
        nodeId: step.nodeId,
        nodeType: step.nodeType,
        outputNamespace: step.outputNamespace,
        nextStep: TOPOLOGY[index + 1]?.nodeId ?? null,
        onErrorStep: step.nodeId === PARSER_NODE_ID ? route : null,
        params: {},
      },
    ]),
  );

  if (route === SHARED_ALERT_NODE_ID) {
    nodes[SHARED_ALERT_NODE_ID] = {
      nodeId: SHARED_ALERT_NODE_ID,
      nodeType: NodeType.DESTINO_SMTP,
      outputNamespace: 'smtp_result',
      nextStep: null,
      onErrorStep: null,
      params: {},
    };
  }

  return {
    ...TEMPLATE,
    pipelineSchema: {
      flowId: 'plantilla',
      name: TEMPLATE.name,
      version: '1.0.0',
      entrypoint: TOPOLOGY[0]?.nodeId ?? '',
      nodes,
    },
  };
};

const buildDraft = async (
  route: unknown = VISION_ROUTE,
): Promise<ReturnType<typeof useFlujoDraftStore>> => {
  const draft = useFlujoDraftStore();
  fetchWorkflowTemplates.mockResolvedValue([TEMPLATE]);
  fetchWorkflowTemplate.mockResolvedValue(buildDetail(route));
  fetchNodeCatalog.mockResolvedValue([]);
  await draft.loadAvailableTemplates();
  await draft.selectTemplate(TEMPLATE_ID);

  return draft;
};

const mountCard = (
  targetNodeId = IA_NODE_ID,
  errorCode: string | null = MULTIMODAL_FALLBACK_CODE,
): ReturnType<typeof mount> =>
  mount(NodeBranchCard, {
    props: {
      sourceNodeId: PARSER_NODE_ID,
      targetNodeId,
      errorCode,
    },
    global: { plugins: [Quasar], components: QUASAR_COMPONENTS },
  });

describe('NodeBranchCard · referencia a la ruta de recuperacion', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    config.global.plugins = [];
    vi.clearAllMocks();
  });

  describe('1. Contenido', () => {
    it('1.1 deberia mostrar el codigo de error que atrapa la ruta', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      await buildDraft();
      const wrapper = mountCard();

      // 3. Assert 🎯
      expect(wrapper.get('[data-test="branch-error-code"]').text()).toBe(
        'ERR_PARSER_UNEXTRACTABLE_MEDIA',
      );
    });

    it('1.2 deberia nombrar el paso que recibe el desvio', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      await buildDraft();
      const wrapper = mountCard();

      // 3. Assert 🎯: el nodo de IA es el tercer paso del flujo.
      const target = wrapper.get('[data-test="branch-target"]');

      expect(target.text()).toContain('Paso 3');
      expect(target.text()).toContain(IA_NODE_ID);
    });

    it('1.3 NO deberia incrustar el formulario del nodo destino', async () => {
      // 1. Arrange 📐: ese nodo esta en el camino NORMAL del flujo y tiene su
      //    propio paso. Pintar aqui su formulario lo mostraria dos veces y
      //    sugeriria que solo corre cuando algo falla, que es falso.
      await buildDraft();

      // 2. Act ⚙️
      const wrapper = mountCard();

      // 3. Assert 🎯
      expect(wrapper.find(`[data-node-id="${IA_NODE_ID}"]`).exists()).toBe(false);
      expect(wrapper.find('.q-field').exists()).toBe(false);
    });
  });

  describe('2. Navegacion', () => {
    it('2.1 deberia llevar el cursor al paso destino', async () => {
      // 1. Arrange 📐
      const draft = await buildDraft();
      const wrapper = mountCard();

      // 2. Act ⚙️
      await wrapper.get('[data-test="branch-jump"]').trigger('click');

      // 3. Assert 🎯
      expect(draft.activeStepDefinition?.nodeId).toBe(IA_NODE_ID);
    });
  });

  describe('3. Rama de alerta', () => {
    it('3.0 deberia nombrar el paso de contingencias como destino', async () => {
      // 1. Arrange 📐: el satelite NO esta en `pipelineTopology` —solo se llega
      //    a el por la ruta—, asi que nombrarlo por ahi diria que "ya no forma
      //    parte de este flujo", que es falso y ademas alarmante.
      await buildDraft(SHARED_ALERT_NODE_ID);

      // 2. Act ⚙️: sin codigo, que es la forma de cadena: atrapa cualquier fallo.
      const wrapper = mountCard(SHARED_ALERT_NODE_ID, null);

      // 3. Assert 🎯
      expect(wrapper.get('[data-test="branch-notice"]').text()).toContain(
        'Contingencias por correo',
      );
      expect(wrapper.find('[data-test="branch-error-code"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="branch-jump"]').exists()).toBe(true);
    });
  });

  describe('4. Destino inexistente', () => {
    it('3.1 deberia avisar en vez de pintar un boton muerto', async () => {
      // 1. Arrange 📐: una ruta que apunta fuera de la topologia es un esquema
      //    roto, y el backend lo rechaza con su regla 3. Aqui se dice.
      await buildDraft();

      // 2. Act ⚙️
      const wrapper = mountCard('nodo_que_ya_no_esta');

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="branch-jump"]').exists()).toBe(false);
      expect(wrapper.get('[data-test="branch-target-missing"]').text()).toContain(
        'nodo_que_ya_no_esta',
      );
    });
  });
});
