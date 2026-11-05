// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { QBtn, Quasar } from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// El aviso se observa doblando `useQuasar`: espiar el plugin llega tarde
// porque el componente captura `$q` al montarse.
const { notify } = vi.hoisted(() => ({ notify: vi.fn() }));

vi.mock('quasar', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('quasar')),
  useQuasar: () => ({ notify }),
}));

vi.mock('@services/telemetry.service', () => ({
  fetchSummary: vi.fn(),
  fetchBreakdownByModel: vi.fn(),
  fetchHistory: vi.fn(),
}));

vi.mock('@services/reports.service', () => ({
  downloadCsv: vi.fn(),
  downloadPdf: vi.fn(),
}));

// Guardar en disco toca el DOM real del navegador: se observa la intencion.
vi.mock('@/utils/file-download', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@/utils/file-download')),
  saveBlob: vi.fn(),
}));

import ExportReportBar from '@components/dashboard/ExportReportBar.vue';
import { useTelemetryStore } from '@stores/telemetry.store';

import { downloadCsv, downloadPdf } from '@services/reports.service';
import { saveBlob } from '@/utils/file-download';

const mountBar = () =>
  mount(ExportReportBar, {
    global: { plugins: [Quasar], components: { QBtn } },
  });

describe('ExportReportBar', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('1.1 deberia descargar el CSV con el nombre del contrato', async () => {
    // 1. Arrange 📐
    const csv = new Blob(['Fecha;Flujo'], { type: 'text/csv' });
    vi.mocked(downloadCsv).mockResolvedValue(csv);
    const wrapper = mountBar();

    // 2. Act ⚙️
    await wrapper.get('[data-test="export-csv"]').trigger('click');
    await flushPromises();

    // 3. Assert 🎯
    expect(downloadCsv).toHaveBeenCalledTimes(1);
    expect(saveBlob).toHaveBeenCalledWith(csv, 'informe-telemetria.csv');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'positive' }));
  });

  it('1.2 deberia descargar el PDF del rango del store', async () => {
    // 1. Arrange 📐
    const pdf = new Blob(['%PDF'], { type: 'application/pdf' });
    vi.mocked(downloadPdf).mockResolvedValue(pdf);
    const store = useTelemetryStore();
    store.setDateRange({ from: '2026-10-01', to: '2026-10-22' });
    const wrapper = mountBar();

    // 2. Act ⚙️
    await wrapper.get('[data-test="export-pdf"]').trigger('click');
    await flushPromises();

    // 3. Assert 🎯
    expect(downloadPdf).toHaveBeenCalledWith(store.query);
    expect(saveBlob).toHaveBeenCalledWith(pdf, 'informe-telemetria.pdf');
  });

  it('1.3 deberia avisar del fallo sin guardar nada', async () => {
    // 1. Arrange 📐
    vi.mocked(downloadPdf).mockRejectedValue(new Error('Network Error'));
    const wrapper = mountBar();

    // 2. Act ⚙️
    await wrapper.get('[data-test="export-pdf"]').trigger('click');
    await flushPromises();

    // 3. Assert 🎯
    expect(saveBlob).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'negative' }));
  });

  it('1.4 deberia deshabilitar las descargas con un rango invalido', () => {
    // 1. Arrange 📐
    const store = useTelemetryStore();
    store.setDateRange({ from: '2026-10-22', to: '2026-10-01' });

    // 2. Act ⚙️
    const wrapper = mountBar();

    // 3. Assert 🎯
    expect(wrapper.get('[data-test="export-pdf"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="export-csv"]').attributes('disabled')).toBeDefined();
  });

  it('1.5 deberia nombrar los dos botones con el verbo Exportar', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const wrapper = mountBar();

    // 3. Assert 🎯
    const labels = wrapper.findAllComponents(QBtn).map((button) => button.props('label'));
    expect(labels).toEqual(['Exportar CSV', 'Exportar informe PDF']);
  });
});
