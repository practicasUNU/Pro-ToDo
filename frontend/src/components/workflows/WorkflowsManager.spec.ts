// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO, como en el resto de specs de componente: montar exige
// DOM, y los specs de store arrancan mas rapido sin el.
import { mount, flushPromises } from '@vue/test-utils';

import { WorkflowStatus } from '@/types/pipeline';
import { createPinia, setActivePinia } from 'pinia';
import {
  Dialog,
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
  discardExecution: vi.fn(),
}));

// La tabla navega al canvas cuando el operador elige el paso alli. No hay
// enrutador real que montar: se observa la intencion de navegar.
const routerPush = vi.fn();

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPush }),
}));

import WorkflowsManager from '@components/workflows/WorkflowsManager.vue';
import { useExecutionStore } from '@stores/execution.store';

import { discardExecution, resumeExecution } from '@services/fsm-executions.service';
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
  status: WorkflowStatus.ACTIVO,
  activeExecutionId: null,
  executionState: null,
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
      plugins: [[Quasar, { plugins: { Dialog, Notify } }]],
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
      vi.mocked(fetchWorkflows).mockResolvedValue([
        buildWorkflow({ status: WorkflowStatus.ACTIVO }),
      ]);

      // 2. Act ⚙️
      const wrapper = mountManager();
      await flushPromises();

      // 3. Assert 🎯: un flujo que nunca se disparo no debe perder su estado.
      expect(wrapper.find('[data-test="status-paused"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="status-running"]').exists()).toBe(false);
      expect(wrapper.text()).toContain('Activo');
    });
  });

  describe('3. Descarte seguro de una ejecucion pausada (CU-09)', () => {
    /** Deja la unica fila del catalogo con su ejecucion detenida. */
    const mountWithPausedRow = async (): Promise<ReturnType<typeof mountManager>> => {
      vi.mocked(fetchWorkflows).mockResolvedValue([buildWorkflow()]);

      const executionStore = useExecutionStore();
      executionStore.executions = [
        buildExecution({
          state: ExecutionState.PAUSADO,
          activeCursor: 'llm_processor',
        }),
      ];

      const wrapper = mountManager();
      await flushPromises();

      return wrapper;
    };

    it('3.1 deberia ofrecer descartar junto a reanudar, y ningun interruptor', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = await mountWithPausedRow();

      // 3. Assert 🎯: la celda de estado NO lleva interruptor —se retiro porque
      //    desactivaba un flujo en marcha de un clic, saltandose el
      //    temporizador— y la fila detenida ofrece las dos unicas salidas que
      //    tiene una PAUSADO.
      expect(wrapper.findComponent({ name: 'QToggle' }).exists()).toBe(false);
      expect(wrapper.find('[data-test="resume-execution"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="discard-execution"]').exists()).toBe(true);
    });

    it('3.1b deberia PREGUNTAR antes de reanudar, en vez de lanzar el reintento', async () => {
      // 1. Arrange 📐: hasta ahora el boton disparaba el POST de un clic. Las
      //    dos formas de reanudar llevan a sitios muy distintos —una ejecuta y
      //    la otra abre una vista—, asi que la eleccion es del operador.
      const wrapper = await mountWithPausedRow();

      // 2. Act ⚙️
      await wrapper.get('[data-test="resume-execution"]').trigger('click');
      await flushPromises();

      // 3. Assert 🎯: SIN temporizador de 5 s —ese esta reservado a lo
      //    irreversible, y reanudar no destruye nada—.
      const dialogText = document.body.textContent ?? '';

      expect(dialogText).toContain('Reanudar desde el ultimo paso fallido');
      expect(dialogText).toContain('Elegir paso en el Canvas');
      expect(resumeExecution).not.toHaveBeenCalled();
    });

    it('3.2 deberia abrir el modal con el boton bloqueado hasta agotar los 5 segundos', async () => {
      // 1. Arrange 📐
      vi.useFakeTimers();

      try {
        const wrapper = await mountWithPausedRow();

        // 2. Act ⚙️
        await wrapper.find('[data-test="discard-execution"]').trigger('click');
        await flushPromises();

        // 3. Assert 🎯: el aviso nombra las DOS consecuencias —la ejecucion se
        //    aborta y el flujo queda inactivo—, y confirmar sigue vetado.
        const dialogText = document.body.textContent ?? '';
        expect(dialogText).toContain('Inactivo');

        const confirmBefore = document.querySelector('.pd-btn-danger');
        expect(confirmBefore?.hasAttribute('disabled')).toBe(true);

        // Consumidos los cinco segundos, el veto cae.
        vi.advanceTimersByTime(5000);
        await flushPromises();

        const confirmAfter = document.querySelector('.pd-btn-danger');
        expect(confirmAfter?.hasAttribute('disabled')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('3.3 deberia descartar la ejecucion que el operador vio, no la vigente al confirmar', async () => {
      // 1. Arrange 📐: entre abrir el dialogo y confirmarlo pasan cinco
      //    segundos; si en ese hueco entra otra ejecucion del mismo flujo,
      //    resolverla al confirmar cerraria una fila distinta de la pulsada.
      const wrapper = await mountWithPausedRow();
      const executionStore = useExecutionStore();

      vi.mocked(discardExecution).mockResolvedValue({
        execution: buildExecution({
          state: ExecutionState.DESCARTADO,
          activeCursor: null,
        }),
        workflow: buildWorkflow({ status: WorkflowStatus.INACTIVO }),
      });

      await wrapper.find('[data-test="discard-execution"]').trigger('click');
      await flushPromises();

      // 2. Act ⚙️: llega una ejecucion mas nueva para el mismo flujo.
      executionStore.executions = [
        ...executionStore.executions,
        buildExecution({
          executionId: 'ffffffff-1111-4222-8333-444444444444',
          startedAt: '2026-03-01T00:00:00.000Z',
        }),
      ];
      await flushPromises();

      // Hay DOS modales de borrado seguro en la vista —desactivar flujo y
      // descartar ejecucion—, asi que se localiza por su titulo: `findComponent`
      // devolveria el primero, que es el otro.
      const discardModal = wrapper
        .findAllComponents({ name: 'SafeDeleteModal' })
        .find((modal) => modal.props('title') === 'Descartar ejecucion pausada');

      discardModal?.vm.$emit('confirm');
      await flushPromises();

      // 3. Assert 🎯
      expect(discardExecution).toHaveBeenCalledWith(EXECUTION_ID);
    });
  });
});
