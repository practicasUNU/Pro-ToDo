// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { ClosePopup, QBtn, QDate, QForm, QIcon, QInput, QPopupProxy, Quasar } from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// El store alcanza `@boot/axios` a traves de su servicio. Ninguna prueba de
// aqui dispara una peticion: el doble solo rompe esa cadena de importacion.
vi.mock('@services/telemetry.service', () => ({
  fetchSummary: vi.fn(),
  fetchBreakdownByModel: vi.fn(),
  fetchHistory: vi.fn(),
}));

vi.mock('@services/reports.service', () => ({
  downloadTelemetryCsv: vi.fn(),
  downloadTelemetryPdf: vi.fn(),
}));

import TelemetryDateRangeFilter from '@components/dashboard/TelemetryDateRangeFilter.vue';
import { useTelemetryStore } from '@stores/telemetry.store';

import { defaultDateRange } from '@/utils/date-range';

/**
 * Escribe en uno de los dos campos a traves de `QInput`.
 *
 * Por el COMPONENTE y no por el `<input>` nativo: con una mascara, `QInput`
 * filtra y reemite el valor por su cuenta, de modo que un `setValue` sobre el
 * elemento se queda en el DOM y nunca llega al `v-model`.
 */
const setRange = async (
  wrapper: ReturnType<typeof mountFilter>,
  from: string,
  to: string,
): Promise<void> => {
  const [fromInput, toInput] = wrapper.findAllComponents(QInput);

  await fromInput?.setValue(from);
  await toInput?.setValue(to);
};

const mountFilter = () =>
  mount(TelemetryDateRangeFilter, {
    global: {
      plugins: [Quasar],
      components: { QBtn, QDate, QForm, QIcon, QInput, QPopupProxy },
      // `v-close-popup` la registra Quasar en la app real; aqui hay que
      // declararla o el montaje avisa de una directiva sin resolver.
      directives: { ClosePopup },
    },
  });

describe('TelemetryDateRangeFilter', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('1.1 deberia volcar el periodo al store y emitir apply', async () => {
    // 1. Arrange 📐
    const wrapper = mountFilter();
    const store = useTelemetryStore();

    await setRange(wrapper, '2026-01-01', '2026-01-31');

    // 2. Act ⚙️
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    // 3. Assert 🎯
    expect(store.dateRange).toEqual({ from: '2026-01-01', to: '2026-01-31' });
    expect(wrapper.emitted('apply')).toHaveLength(1);
  });

  it('1.2 NO deberia aplicar un rango invertido', async () => {
    // 1. Arrange 📐: la validacion es la misma que impone el backend; dejarla
    //    pasar daria un 400 en vez de un mensaje en el campo.
    const wrapper = mountFilter();
    const store = useTelemetryStore();
    const previous = { ...store.dateRange };

    await setRange(wrapper, '2026-02-10', '2026-01-01');

    // 2. Act ⚙️
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    // 3. Assert 🎯
    expect(store.dateRange).toEqual(previous);
    expect(wrapper.emitted('apply')).toBeUndefined();
  });

  it('1.3 deberia devolver el periodo al de partida con "Limpiar filtros"', async () => {
    // 1. Arrange 📐: se restablece al rango por defecto y no se vacia, porque
    //    la consulta exige las dos fechas: en blanco daria un formulario
    //    invalido en lugar de una vista limpia.
    const wrapper = mountFilter();
    const store = useTelemetryStore();

    await setRange(wrapper, '2026-01-01', '2026-01-31');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    // 2. Act ⚙️
    await wrapper.find('[data-test="range-clear"]').trigger('click');

    // 3. Assert 🎯
    expect(store.dateRange).toEqual(defaultDateRange());
    expect(wrapper.emitted('apply')).toHaveLength(2);
  });

  it('1.4 deberia ofrecer el selector propio y no el nativo del navegador', () => {
    // 1. Arrange 📐 + 2. Act ⚙️: el selector nativo se pinta con el tema del
    //    sistema operativo y no admite CSS, de modo que en modo oscuro
    //    aparecia un recuadro blanco en mitad del panel.
    const wrapper = mountFilter();

    // 3. Assert 🎯: el campo deja de ser `type="date"` —que es lo que abria el
    //    selector del navegador— y cada uno estrena su propio disparador.
    expect(wrapper.find('[data-test="range-from"]').attributes('type')).toBe('text');
    expect(wrapper.find('[data-test="range-to"]').attributes('type')).toBe('text');
    expect(wrapper.findAll('.q-field__append .q-icon')).toHaveLength(2);
  });
});
