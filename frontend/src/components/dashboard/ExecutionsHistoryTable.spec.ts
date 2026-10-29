// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  Notify,
  QBadge,
  QBtn,
  QIcon,
  QInput,
  QSelect,
  QTable,
  QTd,
  QTooltip,
  QTr,
  Quasar,
} from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@services/fsm-executions.service', () => ({
  fetchExecutions: vi.fn(),
}));

vi.mock('@services/workflows.service', () => ({
  fetchWorkflows: vi.fn().mockResolvedValue([]),
}));

vi.mock('@services/logs.service', () => ({
  fetchExecutionLog: vi.fn(),
}));

import ExecutionsHistoryTable from '@components/dashboard/ExecutionsHistoryTable.vue';
import { useWorkflowsStore } from '@stores/workflows.store';

import { fetchExecutions } from '@services/fsm-executions.service';
import { fetchExecutionLog } from '@services/logs.service';

import { ExecutionState } from '@/types/execution';
import { WorkflowStatus } from '@/types/pipeline';
import { AUDIT_FIXTURE } from '@/testing/audit.fixture';

import type { ExecutionSummary } from '@/types/execution';

const FLOW_ID = 'f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b';

const buildExecution = (overrides: Partial<ExecutionSummary> = {}): ExecutionSummary => ({
  executionId: 'e1',
  flowId: FLOW_ID,
  state: ExecutionState.EXITOSO,
  activeCursor: null,
  logFilePath: null,
  failureReason: null,
  startedAt: '2026-10-22T08:00:00.000Z',
  updatedAt: '2026-10-22T08:01:00.000Z',
  hasAlerts: false,
  ...overrides,
});

const mountTable = (compact = false) =>
  mount(ExecutionsHistoryTable, {
    props: { compact },
    global: {
      plugins: [[Quasar, { plugins: { Notify } }]],
      components: { QBadge, QBtn, QIcon, QInput, QSelect, QTable, QTd, QTooltip, QTr },
    },
  });

describe('ExecutionsHistoryTable', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('1.1 deberia pintar el estado con texto ademas de color', async () => {
    // 1. Arrange 📐
    vi.mocked(fetchExecutions).mockResolvedValue({
      items: [
        buildExecution(),
        buildExecution({
          executionId: 'e2',
          state: ExecutionState.FALLIDO,
          failureReason: 'El nodo "nodo_ia" fallo (GRAVE).',
        }),
      ],
      total: 2,
      limit: 10,
      offset: 0,
    });

    // 2. Act ⚙️
    const wrapper = mountTable();
    await flushPromises();

    // 3. Assert 🎯
    expect(wrapper.get('[data-test="state-EXITOSO"]').text()).toContain('Exitoso');
    expect(wrapper.get('[data-test="state-FALLIDO"]').classes()).toContain('pd-badge--failed');
    expect(wrapper.text()).toContain('El nodo "nodo_ia" fallo (GRAVE).');
  });

  it('1.2 deberia mostrar el nombre del flujo si el catalogo lo conoce', async () => {
    // 1. Arrange 📐
    useWorkflowsStore().workflows = [
      {
        ...AUDIT_FIXTURE,
        id: FLOW_ID,
        name: 'Notiweb',
        description: null,
        status: WorkflowStatus.ACTIVO,
        activeExecutionId: null,
        executionState: null,
        templateId: null,
        topology: [],
      },
    ];
    vi.mocked(fetchExecutions).mockResolvedValue({
      items: [buildExecution()],
      total: 1,
      limit: 10,
      offset: 0,
    });

    // 2. Act ⚙️
    const wrapper = mountTable();
    await flushPromises();

    // 3. Assert 🎯
    expect(wrapper.text()).toContain('Notiweb');
  });

  it('1.3 la variante compacta deberia pedir 5 filas y ofrecer los filtros de estado, flujo y fecha', async () => {
    // 1. Arrange 📐
    vi.mocked(fetchExecutions).mockResolvedValue({ items: [], total: 0, limit: 5, offset: 0 });

    // 2. Act ⚙️
    const wrapper = mountTable(true);
    await flushPromises();

    // 3. Assert 🎯: el panel de control filtra igual que la vista completa.
    expect(fetchExecutions).toHaveBeenCalledWith({ limit: 5, offset: 0 });
    const selectLabels = wrapper.findAllComponents(QSelect).map((select) => select.props('label'));
    const inputLabels = wrapper.findAllComponents(QInput).map((input) => input.props('label'));
    expect(selectLabels).toEqual(expect.arrayContaining(['Estado', 'Flujo']));
    expect(inputLabels).toEqual(expect.arrayContaining(['Desde', 'Hasta']));
  });

  it('1.4 deberia filtrar por estado y volver a la primera pagina', async () => {
    // 1. Arrange 📐
    vi.mocked(fetchExecutions).mockResolvedValue({ items: [], total: 0, limit: 5, offset: 0 });
    const wrapper = mountTable(true);
    await flushPromises();
    const stateSelect = wrapper
      .findAllComponents(QSelect)
      .find((select) => select.props('label') === 'Estado');

    // 2. Act ⚙️
    stateSelect?.vm.$emit('update:modelValue', ExecutionState.FALLIDO);
    await flushPromises();

    // 3. Assert 🎯
    expect(fetchExecutions).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: ExecutionState.FALLIDO, offset: 0 }),
    );
  });

  it('1.5 deberia aplicar el rango de fechas solo cuando esta completo', async () => {
    // 1. Arrange 📐
    vi.mocked(fetchExecutions).mockResolvedValue({ items: [], total: 0, limit: 5, offset: 0 });
    const wrapper = mountTable(true);
    await flushPromises();
    const inputs = wrapper.findAllComponents(QInput);
    const from = inputs.find((input) => input.props('label') === 'Desde');
    const to = inputs.find((input) => input.props('label') === 'Hasta');
    const callsBefore = vi.mocked(fetchExecutions).mock.calls.length;

    // 2. Act ⚙️: una fecha a medio teclear no dispara nada.
    from?.vm.$emit('update:modelValue', '2026-10');
    await flushPromises();
    const callsWhileTyping = vi.mocked(fetchExecutions).mock.calls.length;
    from?.vm.$emit('update:modelValue', '2026-10-01');
    to?.vm.$emit('update:modelValue', '2026-10-22');
    await flushPromises();

    // 3. Assert 🎯
    expect(callsWhileTyping).toBe(callsBefore);
    expect(fetchExecutions).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: '2026-10-01', to: '2026-10-22', offset: 0 }),
    );
  });

  describe('2. Boton Ver log', () => {
    const mountWith = async (rows: ExecutionSummary[]) => {
      vi.mocked(fetchExecutions).mockResolvedValue({
        items: rows,
        total: rows.length,
        limit: 10,
        offset: 0,
      });
      const wrapper = mountTable();
      await flushPromises();

      return wrapper;
    };

    it('2.1 deberia mostrarse solo en filas FALLIDO, PAUSADO o con alertas', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = await mountWith([
        buildExecution({ executionId: 'fallida', state: ExecutionState.FALLIDO }),
        buildExecution({ executionId: 'pausada', state: ExecutionState.PAUSADO }),
        buildExecution({ executionId: 'alertada', hasAlerts: true }),
        buildExecution({ executionId: 'exitosa' }),
        buildExecution({ executionId: 'en-curso', state: ExecutionState.EN_PROCESO }),
      ]);

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="view-log-fallida"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="view-log-pausada"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="view-log-alertada"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="view-log-exitosa"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="view-log-en-curso"]').exists()).toBe(false);
    });

    it('2.2 deberia abrir el visor con la traza de esa ejecucion', async () => {
      // 1. Arrange 📐
      vi.mocked(fetchExecutionLog).mockResolvedValue({
        executionId: 'fallida',
        timestamp: null,
        level: 'URGENTE',
        stackTrace: 'Error: boom',
        rawLog: '',
        truncated: false,
      });
      const wrapper = await mountWith([
        buildExecution({ executionId: 'fallida', state: ExecutionState.FALLIDO }),
      ]);

      // 2. Act ⚙️
      await wrapper.get('[data-test="view-log-fallida"]').trigger('click');
      await flushPromises();

      // 3. Assert 🎯
      expect(fetchExecutionLog).toHaveBeenCalledWith('fallida');
    });
  });
});
