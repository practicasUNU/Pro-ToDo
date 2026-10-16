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

import { WorkflowStatus, NodeType } from '@/types/pipeline';

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

/** Selector acotado: el lienzo tiene ahora mas de un carril de tarjetas. */
const NOMINAL_CARDS = '.pd-canvas-rail--nominal .pd-node-card';

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
  status: WorkflowStatus.ACTIVO,
  activeExecutionId: null,
  executionState: null,
  templateId: null,
  topology: [],
  pipelineSchema: buildSchema(),
});

/**
 * Variante con una ruta de contingencia hacia un nodo fuera del camino nominal.
 *
 * `onErrorStep` admite las dos formas: la cadena, que atrapa cualquier fallo, y
 * la selectiva, que solo los codigos que enumera. La fabrica cubre ambas con el
 * mismo esqueleto para que las pruebas no dupliquen el esquema entero.
 */
const buildWorkflowWithFork = (
  options: { catchErrors?: string[]; targetNode?: string } = {},
): WorkflowDetail => {
  const schema = buildSchema();
  const targetNode = options.targetNode ?? 'nodo_alerta';

  return {
    ...buildWorkflow(),
    pipelineSchema: {
      ...schema,
      nodes: {
        ...schema.nodes,
        nodo_a: {
          ...schema.nodes.nodo_a!,
          onErrorStep:
            options.catchErrors === undefined
              ? targetNode
              : { targetNode, catchErrors: options.catchErrors },
        },
        nodo_alerta: {
          nodeId: 'nodo_alerta',
          nodeType: NodeType.DESTINO_SMTP,
          outputNamespace: 'smtp_result',
          nextStep: null,
          onErrorStep: null,
          params: {},
        },
      },
    },
  };
};

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
    expect(wrapper.findAll(NOMINAL_CARDS)).toHaveLength(2);
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
    const [first] = wrapper.findAll(NOMINAL_CARDS);
    expect(first?.classes()).toContain('pd-node-card--running');
    expect(wrapper.findComponent(QSpinnerDots).exists()).toBe(true);
  });

  it('1.3 deberia seleccionar el nodo al hacer clic, sin mutar nada mas', async () => {
    // 1. Arrange 📐: el lienzo es de SOLO LECTURA; un clic solo inspecciona.
    const store = useCanvasStore();
    await store.loadCanvas(FLOW_ID);
    const wrapper = mountCanvas();

    // 2. Act ⚙️
    await wrapper.findAll(NOMINAL_CARDS)[1]?.trigger('click');

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
    expect(wrapper.findAll(NOMINAL_CARDS)).toHaveLength(0);
    expect(wrapper.text()).toContain('no tiene un esquema');
  });

  it('1.5 NO deberia renderizar el carril de contingencias sin bifurcaciones', async () => {
    // 1. Arrange 📐: la altura vive en `.pd-fork`, no en el contenedor, asi que
    //    un flujo sin rutas de error no gana ni un pixel vertical.
    const store = useCanvasStore();
    await store.loadCanvas(FLOW_ID);

    // 2. Act ⚙️
    const wrapper = mountCanvas();

    // 3. Assert 🎯
    expect(wrapper.find('.pd-canvas-rail--forks').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Rutas de contingencia');
  });

  it('1.6 deberia proyectar una arista, no un contenedor aislado', async () => {
    // 1. Arrange 📐: es el requisito de la tanda. Antes los nodos de
    //    contingencia se listaban sueltos al pie, sin decir de que paso colgaban.
    fetchWorkflow.mockResolvedValue(buildWorkflowWithFork());
    const store = useCanvasStore();
    await store.loadCanvas(FLOW_ID);

    // 2. Act ⚙️
    const wrapper = mountCanvas();

    // 3. Assert 🎯
    expect(wrapper.findAll('.pd-canvas-fork')).toHaveLength(1);
    expect(wrapper.find('.pd-canvas-rail--forks .pd-node-card--contingency').exists()).toBe(true);
    expect(wrapper.text()).toContain('En caso de error');
  });

  it('1.7 deberia caer en la columna del nodo que declara la ruta', async () => {
    // 1. Arrange 📐: el carril es un ESPEJO del nominal; es lo que alinea el
    //    trazo bajo su nodo sin medir el DOM.
    fetchWorkflow.mockResolvedValue(buildWorkflowWithFork());
    const store = useCanvasStore();
    await store.loadCanvas(FLOW_ID);

    // 2. Act ⚙️
    const wrapper = mountCanvas();

    // 3. Assert 🎯: la ruta la declara `nodo_a`, que es la columna 0.
    const slots = wrapper.findAll('.pd-canvas-slot');
    expect(slots[0]?.find('.pd-canvas-fork').exists()).toBe(true);
    expect(slots[1]?.find('.pd-canvas-fork').exists()).toBe(false);
  });

  it('1.8 deberia distinguir una ruta incondicional de una selectiva', async () => {
    // 1. Arrange 📐: la cadena atrapa CUALQUIER codigo; la forma de objeto solo
    //    los que enumera.
    fetchWorkflow.mockResolvedValue(buildWorkflowWithFork());
    const store = useCanvasStore();
    await store.loadCanvas(FLOW_ID);

    // 2. Act ⚙️
    const unconditional = mountCanvas();

    // 3. Assert 🎯
    expect(unconditional.text()).toContain('Cualquier fallo');

    // 1. Arrange 📐 (segunda mitad): misma topologia, ruta selectiva.
    fetchWorkflow.mockResolvedValue(
      buildWorkflowWithFork({ catchErrors: ['ERR_A', 'ERR_B'], targetNode: 'nodo_alerta' }),
    );
    await store.loadCanvas(FLOW_ID);

    // 2. Act ⚙️
    const selective = mountCanvas();

    // 3. Assert 🎯
    expect(selective.text()).toContain('Solo ERR_A · ERR_B');
    expect(selective.text()).not.toContain('Cualquier fallo');
  });

  it('1.9 deberia marcar como inerte una ruta sin codigos', async () => {
    // 1. Arrange 📐: el backend guarda `catchErrors: []` sin protestar y esa
    //    ruta no se dispara jamas. El canvas es el unico sitio donde se ve.
    fetchWorkflow.mockResolvedValue(
      buildWorkflowWithFork({ catchErrors: [], targetNode: 'nodo_alerta' }),
    );
    const store = useCanvasStore();
    await store.loadCanvas(FLOW_ID);

    // 2. Act ⚙️
    const wrapper = mountCanvas();

    // 3. Assert 🎯
    expect(wrapper.find('.pd-fork-label__codes--inert').exists()).toBe(true);
    expect(wrapper.text()).toContain('no se dispara');
  });

  it('1.10 deberia dibujar UNA tarjeta aunque dos nodos desvien al mismo destino', async () => {
    // 1. Arrange 📐: el alertador es uno por flujo (regla 5 del validador:
    //    `outputNamespace` unico). Duplicar la tarjeta haria leer dos.
    const workflow = buildWorkflowWithFork();
    const schema = workflow.pipelineSchema;

    if (schema !== null) {
      schema.nodes.nodo_b = { ...schema.nodes.nodo_b!, onErrorStep: 'nodo_alerta' };
    }

    fetchWorkflow.mockResolvedValue(workflow);
    const store = useCanvasStore();
    await store.loadCanvas(FLOW_ID);

    // 2. Act ⚙️
    const wrapper = mountCanvas();

    // 3. Assert 🎯: dos trazos, una tarjeta y una referencia.
    expect(wrapper.findAll('.pd-canvas-fork')).toHaveLength(2);
    expect(wrapper.findAll('.pd-node-card--contingency')).toHaveLength(1);
    expect(wrapper.findAll('.pd-fork-ref')).toHaveLength(1);
    expect(wrapper.text()).toContain('Recibe de:');
  });

  it('1.11 deberia referenciar por numero de paso un destino ya nominal', async () => {
    // 1. Arrange 📐: no se dibuja arista de vuelta. En un carril con scroll sus
    //    dos extremos caen fuera de pantalla a la vez, asi que el numero de paso
    //    informa mas que la linea.
    fetchWorkflow.mockResolvedValue(buildWorkflowWithFork({ targetNode: 'nodo_b' }));
    const store = useCanvasStore();
    await store.loadCanvas(FLOW_ID);

    // 2. Act ⚙️
    const wrapper = mountCanvas();

    // 3. Assert 🎯: el total de tarjetas nominales no cambia.
    expect(wrapper.findAll(NOMINAL_CARDS)).toHaveLength(2);
    expect(wrapper.find('.pd-fork-ref').text()).toContain('vuelve al paso 2');
  });

  it('1.12 deberia hacer visible un puntero huerfano', async () => {
    // 1. Arrange 📐: un esquema roto debe VERSE, no desaparecer.
    fetchWorkflow.mockResolvedValue(buildWorkflowWithFork({ targetNode: 'no_existe' }));
    const store = useCanvasStore();
    await store.loadCanvas(FLOW_ID);

    // 2. Act ⚙️
    const wrapper = mountCanvas();

    // 3. Assert 🎯
    expect(wrapper.find('.pd-fork-ref--missing').exists()).toBe(true);
    expect(wrapper.text()).toContain('Destino inexistente');
  });

  it('1.13 deberia dejar el conector fuera del arbol de accesibilidad', async () => {
    // 1. Arrange 📐: el trazo es decorativo; lo que dice viaja como texto en la
    //    etiqueta y en el `aria-label` de la tarjeta destino.
    fetchWorkflow.mockResolvedValue(buildWorkflowWithFork());
    const store = useCanvasStore();
    await store.loadCanvas(FLOW_ID);

    // 2. Act ⚙️
    const wrapper = mountCanvas();

    // 3. Assert 🎯
    expect(wrapper.find('.pd-canvas-fork').attributes('aria-hidden')).toBe('true');
    expect(wrapper.find('.pd-node-card--contingency').attributes('aria-label')).toContain(
      'Contingencia de',
    );
  });

  it('1.14 deberia seleccionar el nodo de contingencia sin mutar su estado', async () => {
    // 1. Arrange 📐: el lienzo sigue siendo de solo lectura en los dos carriles.
    fetchWorkflow.mockResolvedValue(buildWorkflowWithFork());
    const store = useCanvasStore();
    await store.loadCanvas(FLOW_ID);
    const wrapper = mountCanvas();

    // 2. Act ⚙️
    await wrapper.find('.pd-node-card--contingency').trigger('click');

    // 3. Assert 🎯
    expect(store.selectedNodeId).toBe('nodo_alerta');
    expect(store.statusOf('nodo_alerta')).toBe('IDLE');
  });
});
