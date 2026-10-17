// @vitest-environment happy-dom
import { config, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { Notify, QBadge, QBanner, QIcon, QSpinnerDots, Quasar } from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCanvasStore } from '@stores/canvas.store';

import { ExecutionState } from '@/types/execution';
import { NodeType, WorkflowStatus } from '@/types/pipeline';

import type { ExecutionDetail } from '@/types/execution';
import type { WorkflowDetail } from '@/types/pipeline';

const FLOW_ID = 'f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b';
const EXECUTION_ID = '11111111-2222-4333-8444-555555555555';

/** Query de la ruta, reescribible por prueba. */
let routeQuery: Record<string, string> = {};

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/workflows.service', () => ({ fetchWorkflow: vi.fn() }));
vi.mock('@services/fsm-executions.service', () => ({
  fetchActiveExecution: vi.fn(),
  fetchExecution: vi.fn(),
}));
vi.mock('@services/socket-events.service', () => ({
  joinFlowRoom: vi.fn().mockResolvedValue({ ok: true }),
  leaveFlowRoom: vi.fn().mockResolvedValue({ ok: true }),
}));

// La pagina lee `params.id` y `query.resume`, y navega al volver. No hay un
// enrutador real que montar: lo que se prueba es lo que la cabecera decide.
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: FLOW_ID }, query: routeQuery }),
  useRouter: () => ({ push: vi.fn() }),
}));

const workflowsService = await import('@services/workflows.service');
const executionsService = await import('@services/fsm-executions.service');
const fetchWorkflow = vi.mocked(workflowsService.fetchWorkflow);
const fetchActiveExecution = vi.mocked(executionsService.fetchActiveExecution);
const fetchExecution = vi.mocked(executionsService.fetchExecution);

const WorkflowCanvasPage = (await import('./WorkflowCanvasPage.vue')).default;

const buildWorkflow = (status: WorkflowStatus): WorkflowDetail => ({
  id: FLOW_ID,
  name: 'Notiweb - publicacion automatica',
  description: null,
  status,
  activeExecutionId: null,
  executionState: null,
  templateId: null,
  topology: [],
  pipelineSchema: {
    flowId: FLOW_ID,
    name: 'Pipeline',
    version: '1.0.0',
    entrypoint: 'nodo_a',
    nodes: {
      nodo_a: {
        nodeId: 'nodo_a',
        nodeType: NodeType.TRIGGER_IMAP,
        outputNamespace: 'raw_email',
        nextStep: null,
        onErrorStep: null,
        params: {},
      },
    },
  },
});

const buildExecution = (state: ExecutionState): ExecutionDetail => ({
  executionId: EXECUTION_ID,
  flowId: FLOW_ID,
  state,
  activeCursor: 'nodo_a',
  logFilePath: null,
  failureReason: null,
  startedAt: '2026-10-15T08:00:00.000Z',
  updatedAt: '2026-10-15T08:00:05.000Z',
  context: {},
  retryState: {},
});

/** Monta la pagina y espera a que `onMounted` resuelva la carga. */
const mountPage = async (): Promise<ReturnType<typeof mount>> => {
  const wrapper = mount(WorkflowCanvasPage, {
    global: {
      plugins: [[Quasar, { plugins: { Notify } }]],
      components: { QBadge, QBanner, QIcon, QSpinnerDots },
      stubs: { TopologyCanvas: true, NodeInspectionPanel: true },
    },
  });

  await vi.waitFor(() => {
    expect(fetchWorkflow).toHaveBeenCalled();
  });
  await wrapper.vm.$nextTick();
  await wrapper.vm.$nextTick();

  return wrapper;
};

const badgeText = (wrapper: ReturnType<typeof mount>): string =>
  wrapper.get('[data-test="flow-state-badge"]').text();

describe('WorkflowCanvasPage · distintivo de estado del flujo', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    config.global.plugins = [];
    routeQuery = {};
    vi.clearAllMocks();
  });

  describe('1. Estado sin ejecucion viva', () => {
    it('1.1 deberia anunciar un flujo ACTIVO a la espera de su disparador', async () => {
      // 1. Arrange 📐: ES EL DEFECTO QUE SE CORRIGE. Antes el badge se derivaba
      //    solo de la ejecucion, asi que un flujo armado y escuchando —que no
      //    tiene ejecucion viva— se pintaba "INACTIVO".
      fetchWorkflow.mockResolvedValue(buildWorkflow(WorkflowStatus.ACTIVO));
      fetchActiveExecution.mockResolvedValue(null);

      // 2. Act ⚙️
      const wrapper = await mountPage();

      // 3. Assert 🎯
      expect(badgeText(wrapper)).toContain('Activo (En espera de trigger)');
    });

    it('1.2 deberia anunciar INACTIVO un flujo dado de baja', async () => {
      // 1. Arrange 📐
      fetchWorkflow.mockResolvedValue(buildWorkflow(WorkflowStatus.INACTIVO));
      fetchActiveExecution.mockResolvedValue(null);

      // 2. Act ⚙️
      const wrapper = await mountPage();

      // 3. Assert 🎯
      expect(badgeText(wrapper)).toContain('Inactivo');
    });

    it('1.3 deberia anunciar PAUSADO leyendo la fila del flujo', async () => {
      // 1. Arrange 📐: el flujo quedo pausado por el motor. Aunque la consulta
      //    de ejecucion viva no devuelva nada, el estado del flujo lo dice.
      fetchWorkflow.mockResolvedValue(buildWorkflow(WorkflowStatus.PAUSADO));
      fetchActiveExecution.mockResolvedValue(null);

      // 2. Act ⚙️
      const wrapper = await mountPage();

      // 3. Assert 🎯
      expect(badgeText(wrapper)).toContain('Pausado');
    });
  });

  describe('2. Lo que ocurre AHORA manda sobre lo que el flujo es', () => {
    it('2.1 deberia anunciar la ejecucion en curso con spinner', async () => {
      // 1. Arrange 📐
      fetchWorkflow.mockResolvedValue(buildWorkflow(WorkflowStatus.ACTIVO));
      fetchActiveExecution.mockResolvedValue(buildExecution(ExecutionState.EN_PROCESO));

      // 2. Act ⚙️
      const wrapper = await mountPage();

      // 3. Assert 🎯: el spinner ACOMPANA al texto, no lo sustituye. El color
      //    nunca viaja solo.
      expect(badgeText(wrapper)).toContain('En proceso');
      expect(
        wrapper.get('[data-test="flow-state-badge"]').findComponent(QSpinnerDots).exists(),
      ).toBe(true);
    });

    it('2.2 deberia anunciar la ejecucion detenida aunque el flujo ya este ACTIVO', async () => {
      // 1. Arrange 📐: pasa tras reanudar otro intento. Lo que el operador
      //    necesita saber es que hay una ejecucion parada, no que el flujo este
      //    armado.
      fetchWorkflow.mockResolvedValue(buildWorkflow(WorkflowStatus.ACTIVO));
      fetchActiveExecution.mockResolvedValue(buildExecution(ExecutionState.PAUSADO));

      // 2. Act ⚙️
      const wrapper = await mountPage();

      // 3. Assert 🎯
      expect(badgeText(wrapper)).toContain('Pausado');
    });
  });

  describe('3. Guia de la reanudacion selectiva', () => {
    it('3.1 deberia explicar que se espera al llegar con resume=true', async () => {
      // 1. Arrange 📐: sin esto, el operador llega desde la tabla a una vista
      //    que no dice que tiene que hacer.
      routeQuery = { resume: 'true', execId: EXECUTION_ID };
      fetchWorkflow.mockResolvedValue(buildWorkflow(WorkflowStatus.PAUSADO));
      fetchActiveExecution.mockResolvedValue(buildExecution(ExecutionState.PAUSADO));

      // 2. Act ⚙️
      const wrapper = await mountPage();

      // 3. Assert 🎯
      expect(wrapper.get('[data-test="resume-banner"]').text()).toContain(
        'Elige el paso desde el que reanudar',
      );
    });

    it('3.2 NO deberia mostrar la guia sin ejecucion detenida', async () => {
      // 1. Arrange 📐: un enlace guardado con la query no puede invitar a
      //    reanudar un flujo que esta corriendo.
      routeQuery = { resume: 'true' };
      fetchWorkflow.mockResolvedValue(buildWorkflow(WorkflowStatus.ACTIVO));
      fetchActiveExecution.mockResolvedValue(null);

      // 2. Act ⚙️
      const wrapper = await mountPage();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="resume-banner"]').exists()).toBe(false);
    });

    it('3.3 NO deberia mostrar la guia sin la query', async () => {
      // 1. Arrange 📐
      fetchWorkflow.mockResolvedValue(buildWorkflow(WorkflowStatus.PAUSADO));
      fetchActiveExecution.mockResolvedValue(buildExecution(ExecutionState.PAUSADO));

      // 2. Act ⚙️
      const wrapper = await mountPage();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="resume-banner"]').exists()).toBe(false);
    });
  });

  /**
   * EL DEFECTO QUE CIERRA ESTE BLOQUE. Las dos fuentes de la insignia salian de
   * la carga REST y nada las volvia a tocar: el operador veia las cajas
   * encenderse y apagarse mientras la cabecera seguia anunciando el estado con
   * el que habia abierto la pagina, hasta que recargaba con F5.
   */
  describe('4. Conmutacion en vivo, sin recargar', () => {
    it('4.1 deberia recorrer activo → en proceso → pausado → exitoso', async () => {
      // 1. Arrange 📐: se parte de un flujo armado y sin ejecucion viva, que es
      //    como esta justo antes de que entre un correo.
      fetchWorkflow.mockResolvedValue(buildWorkflow(WorkflowStatus.ACTIVO));
      fetchActiveExecution.mockResolvedValue(buildExecution(ExecutionState.INACTIVO));

      const wrapper = await mountPage();
      const store = useCanvasStore();

      expect(badgeText(wrapper)).toContain('Activo (En espera de trigger)');

      // 2. Act ⚙️ & 3. Assert 🎯, paso a paso: lo que se mide es que cada
      //    evento se vea SIN volver a llamar a los servicios.
      store.handleNodeStarted({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-16T08:00:01.000Z',
        nodeId: 'nodo_a',
        nodeType: NodeType.TRIGGER_IMAP,
        stepIndex: 0,
        totalSteps: 1,
        transition: 1,
        attempt: 1,
      });
      await wrapper.vm.$nextTick();
      expect(badgeText(wrapper)).toContain('En proceso');

      store.handleFlowPaused({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-16T08:00:02.000Z',
        activeCursor: 'nodo_a',
        isProgrammedPause: true,
        pausedStepId: 'nodo_a',
      });
      await wrapper.vm.$nextTick();
      expect(badgeText(wrapper)).toContain('Pausado');

      store.handleFlowCompleted({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-16T08:00:03.000Z',
        finalState: ExecutionState.EXITOSO,
      });
      await wrapper.vm.$nextTick();
      expect(badgeText(wrapper)).toContain('Exitoso');

      expect(fetchWorkflow).toHaveBeenCalledTimes(1);
    });

    it('4.2 deberia anunciar la autodesactivacion que llega por crud:mutation', async () => {
      // 1. Arrange 📐: cierre de la politica `stopOnFirstSuccess`. El flujo se
      //    apaga solo y nadie esta pulsando nada en esta vista.
      fetchWorkflow.mockResolvedValue(buildWorkflow(WorkflowStatus.ACTIVO));
      fetchActiveExecution.mockResolvedValue(null);

      const wrapper = await mountPage();
      const store = useCanvasStore();

      // 2. Act ⚙️
      store.applyWorkflowMutation(
        'UPDATED',
        { ...buildWorkflow(WorkflowStatus.INACTIVO) },
        FLOW_ID,
      );
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(badgeText(wrapper)).toContain('Inactivo');
    });

    it('4.3 deberia anunciar una ejecucion que arranca con la vista ya abierta', async () => {
      // 1. Arrange 📐: EL CASO QUE FALLABA. El operador deja el canvas abierto
      //    sobre un flujo armado; la carga REST no ve ninguna ejecucion y el
      //    disparador arranca una despues. Las cajas se encendian, pero la
      //    insignia seguia diciendo «Activo (En espera de trigger)».
      fetchWorkflow.mockResolvedValue(buildWorkflow(WorkflowStatus.ACTIVO));
      fetchActiveExecution.mockResolvedValue(null);
      fetchExecution.mockResolvedValue(buildExecution(ExecutionState.EN_PROCESO));

      const wrapper = await mountPage();
      const store = useCanvasStore();

      expect(badgeText(wrapper)).toContain('Activo (En espera de trigger)');

      // 2. Act ⚙️
      store.handleNodeStarted({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-16T08:00:01.000Z',
        nodeId: 'nodo_a',
        nodeType: NodeType.TRIGGER_IMAP,
        stepIndex: 0,
        totalSteps: 1,
        transition: 1,
        attempt: 1,
      });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(badgeText(wrapper)).toContain('En proceso');
    });
  });
});
