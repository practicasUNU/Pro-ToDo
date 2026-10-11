// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO, como en el resto de specs de componente: montar exige
// DOM, y los specs de store arrancan mas rapido sin el.
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  Notify,
  QBadge,
  QBtn,
  QCard,
  QCardSection,
  QDialog,
  QIcon,
  QInput,
  QSpinner,
  QTable,
  QTd,
  QTooltip,
  QTr,
  Quasar,
} from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// La tabla no habla con la red: se doblan las dos capas de servicio que el
// componente alcanza a traves de sus stores.
vi.mock('@services/socket-events.service', () => ({
  joinFlowRoom: vi.fn().mockResolvedValue({ ok: true }),
  leaveFlowRoom: vi.fn().mockResolvedValue({ ok: true }),
  subscribeToExecutionEvents: vi.fn(),
}));

vi.mock('@services/workflows.service', () => ({
  fetchWorkflows: vi.fn().mockResolvedValue([]),
  updateWorkflow: vi.fn(),
}));

vi.mock('@services/workflow-templates.service', () => ({
  fetchWorkflowTemplates: vi.fn().mockResolvedValue([]),
}));

vi.mock('@services/fsm.service', () => ({
  fetchNodeCatalog: vi.fn().mockResolvedValue([]),
}));

vi.mock('@services/fsm-executions.service', () => ({
  fetchExecutions: vi.fn(),
  fetchExecution: vi.fn(),
  resumeExecution: vi.fn(),
}));

import WorkflowsManager from '@components/workflows/WorkflowsManager.vue';
import { useExecutionStore } from '@stores/execution.store';

import { fetchWorkflows } from '@services/workflows.service';
import { joinFlowRoom, leaveFlowRoom } from '@services/socket-events.service';

import { ExecutionState } from '@/types/execution';

import type { ExecutionSummary } from '@/types/execution';
import type { PipelineSummary } from '@/types/pipeline';

const FLOW_ID = 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const OTHER_FLOW_ID = 'c4e2d3f5-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const EXECUTION_ID = 'd5f3e4a6-7c8d-4e9f-a0b1-2c3d4e5f6071';

const buildWorkflow = (overrides: Partial<PipelineSummary> = {}): PipelineSummary => ({
  id: FLOW_ID,
  name: 'Boletin diario',
  description: null,
  active: true,
  templateId: null,
  topology: [],
  ...overrides,
});

const buildExecution = (overrides: Partial<ExecutionSummary> = {}): ExecutionSummary => ({
  executionId: EXECUTION_ID,
  flowId: FLOW_ID,
  state: ExecutionState.EN_PROCESO,
  activeCursor: 'trigger_imap',
  logFilePath: null,
  failureReason: null,
  startedAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
  ...overrides,
});

/**
 * Registro explicito, como en el resto de specs de componente: el plugin de
 * Quasar instala directivas y plugins, pero no inscribe los componentes, y una
 * `q-table` sin resolver renderiza vacia sin avisar.
 */
const QUASAR_COMPONENTS = {
  QBadge,
  QBtn,
  QCard,
  QCardSection,
  QDialog,
  QIcon,
  QInput,
  QSpinner,
  QTable,
  QTd,
  QTooltip,
  QTr,
};

const mountManager = () =>
  mount(WorkflowsManager, {
    global: {
      plugins: [[Quasar, { plugins: { Notify } }]],
      components: QUASAR_COMPONENTS,
    },
  });

describe('WorkflowsManager · telemetria en vivo del catalogo', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(joinFlowRoom).mockResolvedValue({ ok: true });
    vi.mocked(leaveFlowRoom).mockResolvedValue({ ok: true });
  });

  describe('1. Ciclo de vida de las salas', () => {
    it('1.1 deberia entrar en la sala de cada flujo del catalogo al montar', async () => {
      // 1. Arrange 📐: el catalogo se siembra en el store, de modo que la carga
      //    encuentre ya las filas sin pasar por la capa HTTP.
      vi.mocked(fetchWorkflows).mockResolvedValue([
        buildWorkflow(),
        buildWorkflow({ id: OTHER_FLOW_ID, name: 'Licitaciones' }),
      ]);

      // 2. Act ⚙️
      mountManager();
      await flushPromises();

      // 3. Assert 🎯: sin esto la tabla queda sorda y el estado de cada fila se
      //    congela en el ultimo fetch.
      expect(joinFlowRoom).toHaveBeenCalledWith(FLOW_ID);
      expect(joinFlowRoom).toHaveBeenCalledWith(OTHER_FLOW_ID);
    });

    it('1.2 deberia abandonar todas las salas al desmontar', async () => {
      // 1. Arrange 📐
      vi.mocked(fetchWorkflows).mockResolvedValue([buildWorkflow()]);
      const wrapper = mountManager();
      await flushPromises();

      // 2. Act ⚙️
      wrapper.unmount();
      await flushPromises();

      // 3. Assert 🎯: las salas viven en el servidor y sobrevivirian a la vista.
      expect(leaveFlowRoom).toHaveBeenCalledWith(FLOW_ID);
    });
  });

  describe('2. Reactividad del estado de la fila', () => {
    it('2.1 deberia pintar "Pausado" al llegar flow:paused', async () => {
      // 1. Arrange 📐
      vi.mocked(fetchWorkflows).mockResolvedValue([buildWorkflow()]);
      const executionStore = useExecutionStore();
      executionStore.executions = [buildExecution()];
      const wrapper = mountManager();
      await flushPromises();

      // 2. Act ⚙️: el evento entra por el mismo manejador que engancha el canal.
      executionStore.handleFlowPaused({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        activeCursor: 'llm_processor',
        emittedAt: '2026-02-01T00:05:00.000Z',
        severity: 'GRAVE',
        errorMessage: 'La plantilla aun trae marcadores',
        logFilePath: '/var/log/proto-do/exec.log',
      });
      await flushPromises();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="status-paused"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="resume-execution"]').exists()).toBe(true);
    });

    it('2.2 deberia conservar el badge de habilitacion sin ejecucion viva', async () => {
      // 1. Arrange 📐
      vi.mocked(fetchWorkflows).mockResolvedValue([buildWorkflow({ active: true })]);

      // 2. Act ⚙️
      const wrapper = mountManager();
      await flushPromises();

      // 3. Assert 🎯: un flujo que nunca se disparo no debe perder su estado.
      expect(wrapper.find('[data-test="status-paused"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="status-running"]').exists()).toBe(false);
      expect(wrapper.text()).toContain('Activo');
    });
  });
});
