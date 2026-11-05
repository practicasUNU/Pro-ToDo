// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  ClosePopup,
  QBtn,
  QDate,
  QForm,
  QIcon,
  QInput,
  QPopupProxy,
  QSelect,
  Quasar,
} from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// El store alcanza `@boot/axios` a traves de sus servicios. Ninguna prueba de
// aqui dispara una peticion: el doble solo rompe esa cadena de importacion.
vi.mock('@services/telemetry.service', () => ({
  fetchSummary: vi.fn(),
  fetchBreakdownByModel: vi.fn(),
  fetchHistory: vi.fn(),
  fetchFilterOptions: vi.fn(),
}));

vi.mock('@services/reports.service', () => ({
  downloadCsv: vi.fn(),
  downloadPdf: vi.fn(),
}));

import TelemetryReportFilters from '@components/dashboard/TelemetryReportFilters.vue';
import { useTelemetryStore } from '@stores/telemetry.store';

import { defaultDateRange } from '@/utils/date-range';

const OPTIONS = {
  providers: ['ANTHROPIC', 'GEMINI'],
  models: [
    { aiProvider: 'ANTHROPIC', aiModel: 'claude-sonnet-5-5' },
    { aiProvider: 'GEMINI', aiModel: 'gemini-3.6-flash' },
  ],
  flows: [
    { id: 'f1', name: 'Notiweb' },
    { id: 'f2', name: 'Boletin' },
  ],
  nodes: [
    { flowId: 'f1', nodeId: 'nodo_ia' },
    { flowId: 'f2', nodeId: 'ocr' },
  ],
};

const mountFilters = () =>
  mount(TelemetryReportFilters, {
    global: {
      plugins: [Quasar],
      components: { QBtn, QDate, QForm, QIcon, QInput, QPopupProxy, QSelect },
      // `v-close-popup` la registra Quasar en la app real; aqui hay que
      // declararla o el montaje avisa de una directiva sin resolver.
      directives: { ClosePopup },
    },
  });

type FiltersWrapper = ReturnType<typeof mountFilters>;

/** El `data-test` de QSelect no queda en su raiz: se localiza por su etiqueta. */
const selectByLabel = (wrapper: FiltersWrapper, label: string) =>
  wrapper.findAllComponents(QSelect).find((select) => select.props('label') === label);

/**
 * Escribe las fechas a traves de `QInput` y no del `<input>` nativo: con una
 * mascara, `QInput` filtra y reemite el valor por su cuenta, y un `setValue`
 * sobre el elemento nunca llegaria al `v-model`.
 */
const setRange = async (wrapper: FiltersWrapper, from: string, to: string): Promise<void> => {
  const [fromInput, toInput] = wrapper.findAllComponents(QInput);

  await fromInput?.setValue(from);
  await toInput?.setValue(to);
};

const submit = async (wrapper: FiltersWrapper): Promise<void> => {
  await wrapper.find('form').trigger('submit');
  await flushPromises();
};

describe('TelemetryReportFilters', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  describe('1. Selectores cerrados', () => {
    it('1.1 deberia ofrecer solo los modelos del proveedor elegido', async () => {
      // 1. Arrange 📐
      const store = useTelemetryStore();
      store.filterOptions = OPTIONS;
      store.setFilters({ aiProvider: 'GEMINI' });

      // 2. Act ⚙️
      const wrapper = mountFilters();
      await flushPromises();

      // 3. Assert 🎯: selector cerrado, sin texto libre (Poka-Yoke).
      expect(selectByLabel(wrapper, 'Modelo')?.props('options')).toEqual([
        { label: 'gemini-3.6-flash', value: 'gemini-3.6-flash' },
      ]);
    });

    it('1.2 deberia cambiar de proveedor en el borrador, vaciar el modelo y aplicar solo al pulsar Aplicar', async () => {
      // 1. Arrange 📐
      const store = useTelemetryStore();
      store.filterOptions = OPTIONS;
      store.setFilters({ aiProvider: 'GEMINI', aiModel: 'gemini-3.6-flash' });
      const wrapper = mountFilters();

      // 2. Act ⚙️
      selectByLabel(wrapper, 'Proveedor')?.vm.$emit('update:modelValue', 'ANTHROPIC');
      await flushPromises();
      const filtersBeforeSubmit = { ...store.filters };
      const emittedBeforeSubmit = wrapper.emitted('apply');
      await submit(wrapper);

      // 3. Assert 🎯: elegir no consulta; "Aplicar" vuelca todo de una vez.
      expect(filtersBeforeSubmit).toEqual({ aiProvider: 'GEMINI', aiModel: 'gemini-3.6-flash' });
      expect(emittedBeforeSubmit).toBeUndefined();
      expect(store.filters).toEqual({ aiProvider: 'ANTHROPIC' });
      expect(wrapper.emitted('apply')).toHaveLength(1);
    });

    it('1.3 deberia ofrecer los nodos del flujo elegido', async () => {
      // 1. Arrange 📐
      const store = useTelemetryStore();
      store.filterOptions = OPTIONS;
      store.setFilters({ flowId: 'f2' });

      // 2. Act ⚙️
      const wrapper = mountFilters();
      await flushPromises();

      // 3. Assert 🎯
      expect(selectByLabel(wrapper, 'Nodo')?.props('options')).toEqual([
        { label: 'ocr', value: 'ocr' },
      ]);
    });

    it('1.4 deberia ordenar el desglose de menor a mayor por tokens de prompt al aplicar', async () => {
      // 1. Arrange 📐
      const store = useTelemetryStore();
      const wrapper = mountFilters();

      // 2. Act ⚙️
      selectByLabel(wrapper, 'Ordenar desglose por')?.vm.$emit('update:modelValue', 'promptTokens');
      selectByLabel(wrapper, 'Sentido')?.vm.$emit('update:modelValue', 'ASC');
      await submit(wrapper);

      // 3. Assert 🎯
      expect(store.breakdownSort).toEqual({ sortBy: 'promptTokens', descending: false });
      expect(store.query).toMatchObject({
        breakdownSortBy: 'promptTokens',
        breakdownSortOrder: 'ASC',
      });
      expect(wrapper.emitted('apply')).toHaveLength(1);
    });
  });

  describe('2. Periodo', () => {
    it('2.1 deberia volcar el periodo al store y emitir apply', async () => {
      // 1. Arrange 📐
      const wrapper = mountFilters();
      const store = useTelemetryStore();
      await setRange(wrapper, '2026-01-01', '2026-01-31');

      // 2. Act ⚙️
      await submit(wrapper);

      // 3. Assert 🎯
      expect(store.dateRange).toEqual({ from: '2026-01-01', to: '2026-01-31' });
      expect(wrapper.emitted('apply')).toHaveLength(1);
    });

    it('2.2 NO deberia aplicar un rango invertido', async () => {
      // 1. Arrange 📐: la validacion es la misma que impone el backend; dejarla
      //    pasar daria un 400 en vez de un mensaje en el campo.
      const wrapper = mountFilters();
      const store = useTelemetryStore();
      const previous = { ...store.dateRange };
      await setRange(wrapper, '2026-02-10', '2026-01-01');

      // 2. Act ⚙️
      await submit(wrapper);

      // 3. Assert 🎯
      expect(store.dateRange).toEqual(previous);
      expect(wrapper.emitted('apply')).toBeUndefined();
    });

    it('2.3 deberia devolver periodo, filtros y orden al de partida con "Limpiar filtros"', async () => {
      // 1. Arrange 📐: el periodo se restablece y no se vacia, porque la
      //    consulta exige las dos fechas.
      const store = useTelemetryStore();
      store.setFilters({ aiProvider: 'GEMINI' });
      store.setBreakdownSort({ sortBy: 'costUsd', descending: false });
      const wrapper = mountFilters();
      await setRange(wrapper, '2026-01-01', '2026-01-31');
      await submit(wrapper);

      // 2. Act ⚙️
      await wrapper.find('[data-test="range-clear"]').trigger('click');
      await flushPromises();

      // 3. Assert 🎯
      expect(store.dateRange).toEqual(defaultDateRange());
      expect(store.filters).toEqual({});
      expect(store.breakdownSort).toEqual({ sortBy: null, descending: true });
      expect(selectByLabel(wrapper, 'Proveedor')?.props('modelValue')).toBeNull();
      expect(wrapper.emitted('apply')).toHaveLength(2);
    });

    it('2.4 deberia ofrecer el selector propio y no el nativo del navegador', () => {
      // 1. Arrange 📐 + 2. Act ⚙️: el selector nativo se pinta con el tema del
      //    sistema operativo y no admite CSS.
      const wrapper = mountFilters();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="range-from"]').attributes('type')).toBe('text');
      expect(wrapper.find('[data-test="range-to"]').attributes('type')).toBe('text');
      // Un disparador de calendario por fecha; los selectores traen su flecha.
      const calendarIcons = wrapper
        .findAllComponents(QIcon)
        .filter((icon) => icon.props('name') === 'event');
      expect(calendarIcons).toHaveLength(2);
    });
  });

  describe('3. Acciones', () => {
    it('should render Limpiar filtros button before Aplicar button with respective icons', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = mountFilters();

      // 3. Assert 🎯: las dos acciones cierran la barra, en este orden, y el
      //    primario es el que envia el formulario.
      const buttons = wrapper.findAllComponents(QBtn).filter((button) => {
        const label = button.props('label');
        return label === 'Limpiar filtros' || label === 'Aplicar';
      });

      expect(buttons.map((button) => button.props('label'))).toEqual([
        'Limpiar filtros',
        'Aplicar',
      ]);
      expect(buttons[0]?.props('icon')).toBe('filter_alt_off');
      expect(buttons[1]?.props('icon')).toBe('filter_alt');
      expect(buttons[1]?.props('type')).toBe('submit');
      expect(buttons[1]?.classes()).toContain('pd-btn-primary');
    });
  });
});
