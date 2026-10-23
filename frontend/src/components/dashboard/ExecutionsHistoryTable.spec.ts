// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { Notify, QBadge, QIcon, QSelect, QTable, QTd, QTooltip, QTr, Quasar } from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@services/fsm-executions.service', () => ({
  fetchExecutions: vi.fn(),
}));

vi.mock('@services/workflows.service', () => ({
  fetchWorkflows: vi.fn().mockResolvedValue([]),
}));

import ExecutionsHistoryTable from '@components/dashboard/ExecutionsHistoryTable.vue';
import { useWorkflowsStore } from '@stores/workflows.store';

import { fetchExecutions } from '@services/fsm-executions.service';

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
  ...overrides,
});

const mountTable = (compact = false) =>
  mount(ExecutionsHistoryTable, {
    props: { compact },
    global: {
      plugins: [[Quasar, { plugins: { Notify } }]],
      components: { QBadge, QIcon, QSelect, QTable, QTd, QTooltip, QTr },
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

  it('1.3 la variante compacta deberia pedir 5 filas y no ofrecer filtro', async () => {
    // 1. Arrange 📐
    vi.mocked(fetchExecutions).mockResolvedValue({ items: [], total: 0, limit: 5, offset: 0 });

    // 2. Act ⚙️
    const wrapper = mountTable(true);
    await flushPromises();

    // 3. Assert 🎯
    expect(fetchExecutions).toHaveBeenCalledWith({ limit: 5, offset: 0 });
    expect(wrapper.find('[data-test="state-filter"]').exists()).toBe(false);
  });
});
