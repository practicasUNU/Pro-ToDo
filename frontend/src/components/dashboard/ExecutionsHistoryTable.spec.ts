// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  Notify,
  QBadge,
  QBtn,
  QForm,
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

// El aviso se observa doblando `useQuasar`: espiar el plugin llega tarde
// porque el componente captura `$q` al montarse.
const { notify } = vi.hoisted(() => ({ notify: vi.fn() }));

vi.mock('quasar', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('quasar')),
  useQuasar: () => ({ notify }),
}));

vi.mock('@services/fsm-executions.service', () => ({
  fetchExecutions: vi.fn(),
  downloadExecutionsCsv: vi.fn(),
  downloadExecutionsPdf: vi.fn(),
}));

// Guardar en disco toca el DOM real del navegador: se observa la intencion.
vi.mock('@/utils/file-download', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@/utils/file-download')),
  saveBlob: vi.fn(),
}));

vi.mock('@services/workflows.service', () => ({
  fetchWorkflows: vi.fn().mockResolvedValue([]),
}));

vi.mock('@services/logs.service', () => ({
  fetchExecutionLog: vi.fn(),
}));

import ExecutionsHistoryTable from '@components/dashboard/ExecutionsHistoryTable.vue';
import { useWorkflowsStore } from '@stores/workflows.store';

import {
  downloadExecutionsCsv,
  downloadExecutionsPdf,
  fetchExecutions,
} from '@services/fsm-executions.service';
import { fetchExecutionLog } from '@services/logs.service';
import { toDateInputValue } from '@/utils/date-range';
import { saveBlob } from '@/utils/file-download';

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
      components: { QBadge, QBtn, QForm, QIcon, QInput, QSelect, QTable, QTd, QTooltip, QTr },
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

  it('1.4 deberia filtrar por estado solo al pulsar Aplicar, y volver a la primera pagina', async () => {
    // 1. Arrange 📐
    vi.mocked(fetchExecutions).mockResolvedValue({ items: [], total: 0, limit: 5, offset: 0 });
    const wrapper = mountTable(true);
    await flushPromises();
    const stateSelect = wrapper
      .findAllComponents(QSelect)
      .find((select) => select.props('label') === 'Estado');
    const callsBefore = vi.mocked(fetchExecutions).mock.calls.length;

    // 2. Act ⚙️: elegir no consulta; enviar el formulario si.
    stateSelect?.vm.$emit('update:modelValue', ExecutionState.FALLIDO);
    await flushPromises();
    const callsAfterSelect = vi.mocked(fetchExecutions).mock.calls.length;
    await wrapper.findComponent(QForm).trigger('submit');
    await flushPromises();

    // 3. Assert 🎯
    expect(callsAfterSelect).toBe(callsBefore);
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

    // 2. Act ⚙️: una fecha a medio teclear no se envia ni al aplicar.
    from?.vm.$emit('update:modelValue', '2026-10');
    await wrapper.findComponent(QForm).trigger('submit');
    await flushPromises();
    const callsWhileTyping = vi.mocked(fetchExecutions).mock.calls.length;
    from?.vm.$emit('update:modelValue', '2026-10-01');
    to?.vm.$emit('update:modelValue', '2026-10-22');
    await wrapper.findComponent(QForm).trigger('submit');
    await flushPromises();

    // 3. Assert 🎯
    expect(callsWhileTyping).toBe(callsBefore);
    expect(fetchExecutions).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: '2026-10-01', to: '2026-10-22', offset: 0 }),
    );
  });

  it('1.6 deberia ofrecer Limpiar filtros y Aplicar, y limpiar resetea la consulta', async () => {
    // 1. Arrange 📐
    vi.mocked(fetchExecutions).mockResolvedValue({ items: [], total: 0, limit: 5, offset: 0 });
    const wrapper = mountTable(true);
    await flushPromises();
    wrapper
      .findAllComponents(QSelect)
      .find((select) => select.props('label') === 'Estado')
      ?.vm.$emit('update:modelValue', ExecutionState.FALLIDO);
    await wrapper.findComponent(QForm).trigger('submit');
    await flushPromises();

    // 2. Act ⚙️
    await wrapper.find('[data-test="executions-clear"]').trigger('click');
    await flushPromises();

    // 3. Assert 🎯
    expect(wrapper.find('[data-test="executions-apply"]').text()).toContain('Aplicar');
    expect(wrapper.find('[data-test="executions-clear"]').text()).toContain('Limpiar filtros');
    const lastQuery = vi.mocked(fetchExecutions).mock.calls.at(-1)?.[0];
    expect(lastQuery).not.toHaveProperty('state');
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

  describe('3. Exportar CSV', () => {
    const CSV_BLOB = new Blob(['Ejecución;Flujo'], { type: 'text/csv' });

    const mountLoaded = async () => {
      vi.mocked(fetchExecutions).mockResolvedValue({ items: [], total: 0, limit: 5, offset: 0 });
      const wrapper = mountTable(true);
      await flushPromises();

      return wrapper;
    };

    const exportButton = (wrapper: Awaited<ReturnType<typeof mountLoaded>>) =>
      wrapper
        .findAllComponents(QBtn)
        .find((button) => button.attributes('data-test') === 'executions-export');

    it('3.1 deberia descargar el historial con el nombre fechado del dia', async () => {
      // 1. Arrange 📐
      vi.mocked(downloadExecutionsCsv).mockResolvedValue(CSV_BLOB);
      const wrapper = await mountLoaded();

      // 2. Act ⚙️
      await wrapper.get('[data-test="executions-export"]').trigger('click');
      await flushPromises();

      // 3. Assert 🎯
      expect(downloadExecutionsCsv).toHaveBeenCalledTimes(1);
      expect(saveBlob).toHaveBeenCalledWith(
        CSV_BLOB,
        `historial-ejecuciones-${toDateInputValue(new Date())}.csv`,
      );
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'positive' }));
    });

    it('3.2 deberia exportar los filtros APLICADOS y no el borrador sin aplicar', async () => {
      // 1. Arrange 📐: se aplica FALLIDO y despues se elige PAUSADO sin aplicar.
      vi.mocked(downloadExecutionsCsv).mockResolvedValue(CSV_BLOB);
      const wrapper = await mountLoaded();
      const stateSelect = () =>
        wrapper.findAllComponents(QSelect).find((select) => select.props('label') === 'Estado');
      stateSelect()?.vm.$emit('update:modelValue', ExecutionState.FALLIDO);
      await wrapper.findComponent(QForm).trigger('submit');
      await flushPromises();
      stateSelect()?.vm.$emit('update:modelValue', ExecutionState.PAUSADO);
      await flushPromises();

      // 2. Act ⚙️
      await wrapper.get('[data-test="executions-export"]').trigger('click');
      await flushPromises();

      // 3. Assert 🎯: lo que muestra la tabla, sin la ventana de pagina.
      expect(downloadExecutionsCsv).toHaveBeenCalledWith({ state: ExecutionState.FALLIDO });
    });

    it('3.3 deberia deshabilitarse mientras se descarga', async () => {
      // 1. Arrange 📐
      let resolveDownload: (blob: Blob) => void = () => undefined;
      vi.mocked(downloadExecutionsCsv).mockReturnValue(
        new Promise<Blob>((resolve) => {
          resolveDownload = resolve;
        }),
      );
      const wrapper = await mountLoaded();

      // 2. Act ⚙️
      await wrapper.get('[data-test="executions-export"]').trigger('click');
      await flushPromises();
      const disabledDuringDownload = exportButton(wrapper)?.props('disable');
      resolveDownload(CSV_BLOB);
      await flushPromises();

      // 3. Assert 🎯
      expect(disabledDuringDownload).toBe(true);
      expect(exportButton(wrapper)?.props('disable')).toBe(false);
    });

    it('3.4 deberia avisar del fallo sin guardar ningun fichero', async () => {
      // 1. Arrange 📐
      vi.mocked(downloadExecutionsCsv).mockRejectedValue(new Error('Network Error'));
      const wrapper = await mountLoaded();

      // 2. Act ⚙️
      await wrapper.get('[data-test="executions-export"]').trigger('click');
      await flushPromises();

      // 3. Assert 🎯
      expect(saveBlob).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'negative' }));
      expect(exportButton(wrapper)?.props('disable')).toBe(false);
    });
  });

  describe('4. Exportar informe PDF', () => {
    const PDF_BLOB = new Blob(['%PDF-1.7'], { type: 'application/pdf' });

    const mountLoaded = async () => {
      vi.mocked(fetchExecutions).mockResolvedValue({ items: [], total: 0, limit: 5, offset: 0 });
      const wrapper = mountTable(true);
      await flushPromises();

      return wrapper;
    };

    const pdfButton = (wrapper: Awaited<ReturnType<typeof mountLoaded>>) =>
      wrapper
        .findAllComponents(QBtn)
        .find((button) => button.attributes('data-test') === 'executions-export-pdf');

    it('4.1 deberia colocarse entre Exportar CSV y Limpiar filtros', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = await mountLoaded();

      // 3. Assert 🎯: orden real del DOM, no solo que existan.
      const actionOrder = wrapper
        .findAll('.pd-executions-filters__actions [data-test]')
        .map((node) => node.attributes('data-test'));
      expect(actionOrder).toEqual([
        'executions-export',
        'executions-export-pdf',
        'executions-clear',
        'executions-apply',
      ]);
      expect(wrapper.get('[data-test="executions-export-pdf"]').text()).toContain(
        'Exportar informe PDF',
      );
    });

    it('4.2 deberia descargar el PDF con el nombre fechado del dia', async () => {
      // 1. Arrange 📐
      vi.mocked(downloadExecutionsPdf).mockResolvedValue(PDF_BLOB);
      const wrapper = await mountLoaded();

      // 2. Act ⚙️
      await wrapper.get('[data-test="executions-export-pdf"]').trigger('click');
      await flushPromises();

      // 3. Assert 🎯
      expect(downloadExecutionsPdf).toHaveBeenCalledTimes(1);
      expect(downloadExecutionsCsv).not.toHaveBeenCalled();
      expect(saveBlob).toHaveBeenCalledWith(
        PDF_BLOB,
        `historial-ejecuciones-${toDateInputValue(new Date())}.pdf`,
      );
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'positive' }));
    });

    it('4.3 deberia exportar los filtros APLICADOS', async () => {
      // 1. Arrange 📐
      vi.mocked(downloadExecutionsPdf).mockResolvedValue(PDF_BLOB);
      const wrapper = await mountLoaded();
      wrapper
        .findAllComponents(QSelect)
        .find((select) => select.props('label') === 'Estado')
        ?.vm.$emit('update:modelValue', ExecutionState.FALLIDO);
      await wrapper.findComponent(QForm).trigger('submit');
      await flushPromises();

      // 2. Act ⚙️
      await wrapper.get('[data-test="executions-export-pdf"]').trigger('click');
      await flushPromises();

      // 3. Assert 🎯
      expect(downloadExecutionsPdf).toHaveBeenCalledWith({ state: ExecutionState.FALLIDO });
    });

    it('4.4 deberia deshabilitarse solo el boton PDF mientras se genera', async () => {
      // 1. Arrange 📐
      let resolveDownload: (blob: Blob) => void = () => undefined;
      vi.mocked(downloadExecutionsPdf).mockReturnValue(
        new Promise<Blob>((resolve) => {
          resolveDownload = resolve;
        }),
      );
      const wrapper = await mountLoaded();
      const csvButton = () =>
        wrapper
          .findAllComponents(QBtn)
          .find((button) => button.attributes('data-test') === 'executions-export');

      // 2. Act ⚙️
      await wrapper.get('[data-test="executions-export-pdf"]').trigger('click');
      await flushPromises();
      const pdfDuringDownload = {
        disable: pdfButton(wrapper)?.props('disable'),
        loading: pdfButton(wrapper)?.props('loading'),
      };
      const csvDisabledDuringDownload = csvButton()?.props('disable');
      resolveDownload(PDF_BLOB);
      await flushPromises();

      // 3. Assert 🎯
      expect(pdfDuringDownload).toEqual({ disable: true, loading: true });
      expect(csvDisabledDuringDownload).toBe(false);
      expect(pdfButton(wrapper)?.props('disable')).toBe(false);
    });

    it('4.5 deberia avisar del fallo sin guardar ningun fichero', async () => {
      // 1. Arrange 📐
      vi.mocked(downloadExecutionsPdf).mockRejectedValue(new Error('Network Error'));
      const wrapper = await mountLoaded();

      // 2. Act ⚙️
      await wrapper.get('[data-test="executions-export-pdf"]').trigger('click');
      await flushPromises();

      // 3. Assert 🎯
      expect(saveBlob).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'negative' }));
      expect(pdfButton(wrapper)?.props('disable')).toBe(false);
    });
  });
});
