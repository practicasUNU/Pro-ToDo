// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO, igual que el resto de specs de componente: los de
// store no necesitan DOM y arrancan mas rapido sin el.
import { config, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { QBadge, QBanner, QIcon, QSpinnerDots, Quasar } from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TopologyCanvas from '@components/canvas/TopologyCanvas.vue';
import { useCanvasStore } from '@stores/canvas.store';

import { NodeType } from '@/types/pipeline';

import type { AssembledPipelineSchema, WorkflowDetail } from '@/types/pipeline';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/workflows.service', () => ({ fetchWorkflow: vi.fn() }));
vi.mock('@services/fsm-executions.service', () => ({ fetchActiveExecution: vi.fn() }));
vi.mock('@services/socket-events.service', () => ({
  joinFlowRoom: vi.fn().mockResolvedValue({ ok: true }),
  leaveFlowRoom: vi.fn().mockResolvedValue({ ok: true }),
}));

const workflowsService = await import('@services/workflows.service');
const executionsService = await import('@services/fsm-executions.service');
const fetchWorkflow = vi.mocked(workflowsService.fetchWorkflow);
const fetchActiveExecution = vi.mocked(executionsService.fetchActiveExecution);

const FLOW_ID = 'f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b';

const QUASAR_COMPONENTS = { QBadge, QBanner, QIcon, QSpinnerDots };

const buildSchema = (): AssembledPipelineSchema => ({
  flowId: FLOW_ID,
  name: 'Pipeline de prueba',
  version: '1.0.0',
  entrypoint: 'nodo_a',
  nodes: {
    nodo_a: {
      nodeId: 'nodo_a',
      nodeType: NodeType.TRIGGER_IMAP,
      outputNamespace: 'raw_email',
      nextStep: 'nodo_b',
      onErrorStep: null,
      params: {},
    },
    nodo_b: {
      nodeId: 'nodo_b',
      nodeType: NodeType.PROCESADOR_IA,
      outputNamespace: 'llm_response',
      nextStep: null,
      onErrorStep: null,
      params: {},
    },
  },
});

const buildWorkflow = (): WorkflowDetail => ({
  id: FLOW_ID,
  name: 'Notiweb',
  description: null,
  active: true,
  templateId: null,
  topology: [],
  pipelineSchema: buildSchema(),
});

const mountCanvas = (): ReturnType<typeof mount> =>
  mount(TopologyCanvas, {
    global: { plugins: [Quasar], components: QUASAR_COMPONENTS },
  });

describe('TopologyCanvas · lienzo de solo lectura', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    config.global.plugins = [];
    vi.clearAllMocks();
    fetchWorkflow.mockResolvedValue(buildWorkflow());
    fetchActiveExecution.mockResolvedValue(null);
  });

  it('1.1 deberia pintar una caja por nodo del camino nominal', async () => {
    // 1. Arrange 📐
    const store = useCanvasStore();
    await store.loadCanvas(FLOW_ID);

    // 2. Act ⚙️
    const wrapper = mountCanvas();

    // 3. Assert 🎯
    expect(wrapper.findAll('.pd-node-card')).toHaveLength(2);
    expect(wrapper.text()).toContain('Disparador IMAP');
    expect(wrapper.text()).toContain('Procesador IA');
  });

  it('1.2 deberia reflejar el estado del nodo con su modificador de clase', async () => {
    // 1. Arrange 📐: el estado se expresa con una clase y nunca con un `style`
    //    inline, que `frontend-quasar.md` §2 prohibe.
    const store = useCanvasStore();
    await store.loadCanvas(FLOW_ID);
    store.handleNodeStarted({
      executionId: '11111111-2222-4333-8444-555555555555',
      flowId: FLOW_ID,
      emittedAt: '2026-10-15T08:00:01.000Z',
      nodeId: 'nodo_a',
      nodeType: NodeType.TRIGGER_IMAP,
      stepIndex: 0,
      totalSteps: 2,
      transition: 1,
      attempt: 1,
    });

    // 2. Act ⚙️
    const wrapper = mountCanvas();

    // 3. Assert 🎯
    const [first] = wrapper.findAll('.pd-node-card');
    expect(first?.classes()).toContain('pd-node-card--running');
    expect(wrapper.findComponent(QSpinnerDots).exists()).toBe(true);
  });

  it('1.3 deberia seleccionar el nodo al hacer clic, sin mutar nada mas', async () => {
    // 1. Arrange 📐: el lienzo es de SOLO LECTURA; un clic solo inspecciona.
    const store = useCanvasStore();
    await store.loadCanvas(FLOW_ID);
    const wrapper = mountCanvas();

    // 2. Act ⚙️
    await wrapper.findAll('.pd-node-card')[1]?.trigger('click');

    // 3. Assert 🎯
    expect(store.selectedNodeId).toBe('nodo_b');
    expect(store.statusOf('nodo_b')).toBe('IDLE');
  });

  it('1.4 deberia avisar cuando el flujo no tiene esquema guardado', async () => {
    // 1. Arrange 📐
    fetchWorkflow.mockResolvedValue({ ...buildWorkflow(), pipelineSchema: null });
    const store = useCanvasStore();
    await store.loadCanvas(FLOW_ID);

    // 2. Act ⚙️
    const wrapper = mountCanvas();

    // 3. Assert 🎯
    expect(wrapper.findAll('.pd-node-card')).toHaveLength(0);
    expect(wrapper.text()).toContain('no tiene un esquema');
  });
});
