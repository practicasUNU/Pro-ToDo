// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO y no `environment` global en `vitest.config.ts`: los
// otros dieciseis specs prueban stores y utilidades puras, que no necesitan DOM
// y corren mas rapido sin el. Montar un componente si lo necesita, y declararlo
// aqui deja la configuracion compartida intacta.
import { config, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  QBadge,
  QBtn,
  QCard,
  QIcon,
  QInput,
  QItem,
  QItemLabel,
  QItemSection,
  QSelect,
  QToggle,
  QTooltip,
  Quasar,
} from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import WebScraperConfig from '@components/nodes/WebScraperConfig.vue';
import {
  EXCLUDED_DOMAIN_SUGGESTIONS,
  indexedUrlTemplateFor,
  SELECTABLE_URL_SLOTS,
  useWebScraperStore,
} from '@stores/nodes/web-scraper.store';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';
import type { CheckScraperResult } from '@/types/web-scraper';

// Mismo doble que en el spec del store: sin esto se cargaria `@boot/axios`, y
// ademas el componente no debe tocar la red ni en pruebas.
vi.mock('@services/nodes/web-scraper.service', () => ({
  checkScraper: vi.fn(),
}));

const webScraperService = await import('@services/nodes/web-scraper.service');
const checkScraper = vi.mocked(webScraperService.checkScraper);

const NODE_ID = 'extractor_web';
const SANDBOX_URL = 'https://www.ejemplo.es/noticias/nota-de-prensa';

/** Contexto que dejaria un PARSER_PRE_IA aguas arriba del extractor. */
const PARSER_UPSTREAM: UpstreamNamespace[] = [
  {
    namespace: 'parsed_email',
    fields: [{ name: 'extracted_urls', type: 'url[]' }],
  },
];

/**
 * El `QSelect` de chips de dominios, localizado por su clase.
 *
 * Por COMPONENTE y no por elemento: hace falta el componente que emite
 * `update:model-value`, y desde el nodo raiz ya no se puede subir hasta el.
 * Se filtra por CLASE y no por `data-test` porque `QSelect` no propaga a su raiz
 * los atributos que no conoce —se ve en el DOM renderizado—, mientras que
 * `class` si llega. Es el mismo motivo por el que el resto del archivo localiza
 * los selects por nombre de componente.
 */
const findExcludedDomainsSelect = (wrapper: ReturnType<typeof mountComponent>) =>
  wrapper
    .findAllComponents({ name: 'QSelect' })
    .filter((select) => select.classes().includes('pd-excluded-domains'))[0];

/** Plantilla de la posicion `index` de los enlaces del parser. */
const parsedEmailUrl = (index: number): string =>
  indexedUrlTemplateFor('parsed_email', 'extracted_urls', index);

const buildResult = (): CheckScraperResult => ({
  success: true,
  preview: {
    source_url: SANDBOX_URL,
    article_title: 'Titular de la nota',
    full_article_content: 'Primer parrafo.\n\nSegundo parrafo.',
    byline: null,
    scraped_at: '2026-09-21T10:00:00.000Z',
  },
  metrics: {
    elapsedMs: 1_200,
    attempts: 1,
    redirected: false,
    contentLength: 360,
  },
});

/**
 * Componentes de Quasar usados por el configurador.
 *
 * Se registran a mano porque el plugin `Quasar` instala directivas y plugins
 * pero NO componentes: en la aplicacion los inyecta el plugin de Vite de Quasar,
 * que aqui no corre. Sin esto, `<q-select>` se renderiza como una etiqueta
 * desconocida y la prueba 1.1 pasaria por el motivo equivocado.
 */
const QUASAR_COMPONENTS = {
  QBadge,
  QBtn,
  QCard,
  QIcon,
  QInput,
  QItem,
  QItemLabel,
  QItemSection,
  QSelect,
  QToggle,
  QTooltip,
};

/**
 * Se montan los componentes REALES de Quasar, no stubs.
 *
 * Con stubs, la prueba 1.1 —"es un selector cerrado y no un campo de texto
 * libre"— seria circular: aseveraria sobre el doble que la propia prueba acaba
 * de declarar, no sobre lo que el componente monta. Con los reales, `QSelect` se
 * renderiza de verdad y el aserto mira el DOM que vera el operador.
 */
const mountComponent = (): ReturnType<typeof mount> =>
  mount(WebScraperConfig, {
    props: { nodeId: NODE_ID },
    global: { plugins: [Quasar], components: QUASAR_COMPONENTS },
  });

describe('WebScraperConfig · configurador del nodo EXTRACTOR_WEB', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    config.global.plugins = [];
    vi.clearAllMocks();
  });

  describe('1. Poka-Yoke del selector de URL', () => {
    it('1.1 deberia renderizar un selector cerrado y no un campo de texto libre', () => {
      // 1. Arrange & 2. Act
      const wrapper = mountComponent();
      const select = wrapper.findComponent({ name: 'QSelect' });

      // 3. Assert: la regla §4 prohibe escribir la variable a mano. `useInput`
      //    es LA propiedad que abre un `QSelect` a texto libre, asi que
      //    comprobarla es la diferencia exacta entre el selector determinista y
      //    un campo donde el operador podria teclear un namespace inventado.
      //    Se asevera ademas que el unico `<input>` del control es `readonly`,
      //    que es como se ve desde el DOM que vera el operador. El aserto se
      //    acota AL SELECTOR y no al formulario entero a proposito: el campo del
      //    banco de pruebas si es texto libre, y debe serlo —ahi el operador
      //    escribe una URL real—, asi que un aserto global fallaria por el
      //    motivo equivocado.
      expect(select.exists()).toBe(true);
      expect(select.props('useInput')).toBeFalsy();
      expect(select.find('input').attributes('readonly')).toBeDefined();
    });

    it('1.2 deberia ofrecer una opcion por posicion del campo de enlaces', () => {
      // 1. Arrange
      mountComponent();
      const store = useWebScraperStore(NODE_ID);

      // 2. Act: las opciones las compone la TOPOLOGIA, no una constante.
      store.setAvailableUpstreamContext(PARSER_UPSTREAM);

      // 3. Assert: son CRITERIOS y POSICIONES, nunca URLs: en tiempo de
      //    diseno el correo todavia no ha llegado. La primera opcion delega la
      //    eleccion en el nodo; las diez siguientes fijan la posicion.
      expect(store.urlOptions).toHaveLength(SELECTABLE_URL_SLOTS + 1);
      expect(store.urlOptions[1]?.value).toBe(parsedEmailUrl(0));
    });

    it('1.3 deberia deshabilitar el selector sin origenes aguas arriba', async () => {
      // 1. Arrange
      const wrapper = mountComponent();
      const store = useWebScraperStore(NODE_ID);

      // 2. Act & 3. Assert: un selector habilitado y vacio invita a pensar que
      //    falta cargar algo; deshabilitado con su aviso dice lo que pasa.
      expect(wrapper.findComponent({ name: 'QSelect' }).props('disable')).toBe(true);
      expect(wrapper.find('[data-test="missing-source-warning"]').exists()).toBe(true);

      store.setAvailableUpstreamContext(PARSER_UPSTREAM);
      await wrapper.vm.$nextTick();

      expect(wrapper.findComponent({ name: 'QSelect' }).props('disable')).toBe(false);
      expect(wrapper.find('[data-test="missing-source-warning"]').exists()).toBe(false);
    });

    it('1.4 deberia exponer el toggle de omision reflejando el store', async () => {
      // 1. Arrange
      const wrapper = mountComponent();
      const store = useWebScraperStore(NODE_ID);
      const toggle = wrapper.findComponent({ name: 'QToggle' });

      // 2. Act & 3. Assert: nace activo, como el defecto del DTO del backend.
      expect(toggle.exists()).toBe(true);
      expect(toggle.props('modelValue')).toBe(true);

      store.updateConfig({ skipIfEmpty: false });
      await wrapper.vm.$nextTick();

      expect(
        wrapper.findComponent({ name: 'QToggle' }).props('modelValue'),
      ).toBe(false);
    });

    it('1.5 deberia escribir en el store al conmutar el toggle', async () => {
      // 1. Arrange
      const wrapper = mountComponent();
      const store = useWebScraperStore(NODE_ID);

      // 2. Act
      await wrapper
        .findComponent({ name: 'QToggle' })
        .vm.$emit('update:model-value', false);

      // 3. Assert: el componente no guarda estado propio; el store es el dueno.
      expect(store.config.skipIfEmpty).toBe(false);
    });

    it('1.7 deberia bloquear el toggle mientras no haya origen aguas arriba', async () => {
      // 1. Arrange 📐: apagarlo produciria un esquema que la regla 8 del backend
      //    rechaza al guardar, asi que no se ofrece la eleccion.
      const wrapper = mountComponent();
      const store = useWebScraperStore(NODE_ID);

      // 2. Act & 3. Assert
      expect(wrapper.findComponent({ name: 'QToggle' }).props('disable')).toBe(true);
      expect(wrapper.find('[data-test="skip-if-empty-locked-hint"]').exists()).toBe(true);

      store.setAvailableUpstreamContext(PARSER_UPSTREAM);
      await wrapper.vm.$nextTick();

      expect(wrapper.findComponent({ name: 'QToggle' }).props('disable')).toBe(false);
      expect(wrapper.find('[data-test="skip-if-empty-locked-hint"]').exists()).toBe(false);
    });

    it('1.6 deberia degradar el aviso de topologia a informativo con la bandera', async () => {
      // 1. Arrange: sin origenes aguas arriba el aviso se muestra en los dos
      //    casos, pero no significa lo mismo: con la bandera activa el flujo de
      //    contingencia es legitimo y no hay nada que corregir.
      const wrapper = mountComponent();
      const store = useWebScraperStore(NODE_ID);
      const banner = () => wrapper.find('[data-test="missing-source-warning"]');

      // 2. Act & 3. Assert
      expect(banner().classes()).toContain('pd-info-banner');

      store.updateConfig({ skipIfEmpty: false });
      await wrapper.vm.$nextTick();

      expect(banner().classes()).toContain('pd-warn-banner');
    });
  });

  describe('2. Reactividad contra el store', () => {
    it('2.1 deberia actualizar el store al cambiar la seleccion', async () => {
      // 1. Arrange
      const wrapper = mountComponent();
      const store = useWebScraperStore(NODE_ID);
      store.setAvailableUpstreamContext(PARSER_UPSTREAM);

      // 2. Act: se emite el evento que emitiria el `QSelect` al elegir la
      //    tercera posicion, que es el contrato que el componente escucha.
      await wrapper
        .findComponent({ name: 'QSelect' })
        .vm.$emit('update:model-value', parsedEmailUrl(2));

      // 3. Assert: el componente no guarda estado propio; el dueno de la
      //    configuracion es el store (regla §5).
      expect(store.config.targetUrl).toBe(parsedEmailUrl(2));
    });

    it('2.3 deberia escribir en el store los dominios excluidos, normalizados', async () => {
      // 1. Arrange
      const wrapper = mountComponent();
      const store = useWebScraperStore(NODE_ID);

      // 2. Act: el evento que emite el `QSelect` de chips al anadir uno.
      await findExcludedDomainsSelect(wrapper)?.vm.$emit('update:model-value', [
        'MadrimasD.ORG',
        ' madrimasd.org ',
      ]);

      // 3. Assert: a minusculas y sin repetir, igual que hace el backend al
      //    resolver la configuracion.
      expect(store.config.excludedDomains).toEqual(['madrimasd.org']);
    });

    it('2.4 deberia ofrecer el portal institucional como SUGERENCIA, no como valor', () => {
      // 1. Arrange & 2. Act
      const wrapper = mountComponent();
      const store = useWebScraperStore(NODE_ID);

      // 3. Assert: la lista arranca vacia; sembrarla cambiaria el
      //    comportamiento de todo flujo que se reabra sin que nadie lo pida.
      expect(store.config.excludedDomains).toEqual([]);
      expect(findExcludedDomainsSelect(wrapper)?.props('options')).toEqual([
        ...EXCLUDED_DOMAIN_SUGGESTIONS,
      ]);
    });

    it('2.2 deberia reflejar en el badge la validez que declara el store', async () => {
      // 1. Arrange
      const wrapper = mountComponent();
      const store = useWebScraperStore(NODE_ID);
      store.setAvailableUpstreamContext(PARSER_UPSTREAM);
      store.updateConfig({ targetUrl: parsedEmailUrl(0) });
      await wrapper.vm.$nextTick();
      expect(wrapper.text()).toContain('Configurado');

      // 2. Act: el operador reordena el flujo y el parser deja de ir delante,
      //    asi que el enlace elegido ya no existira en el contexto.
      store.setAvailableUpstreamContext([
        { namespace: 'raw_email', fields: [{ name: 'subject', type: 'text' }] },
      ]);
      await wrapper.vm.$nextTick();

      // 3. Assert
      expect(store.isConfigValid).toBe(false);
      expect(wrapper.text()).toContain('Incompleto');
      expect(wrapper.find('[data-test="missing-source-warning"]').exists()).toBe(true);
    });

    it('2.3 deberia deshabilitar la prueba mientras no haya URL real', async () => {
      // 1. Arrange
      const wrapper = mountComponent();
      const store = useWebScraperStore(NODE_ID);

      // 2. Act & 3. Assert
      expect(store.canRunSandbox).toBe(false);

      store.setSandboxUrl(SANDBOX_URL);
      await wrapper.vm.$nextTick();

      expect(store.canRunSandbox).toBe(true);
    });

    it('2.4 deberia pintar el texto extraido tras una prueba con exito', async () => {
      // 1. Arrange
      const wrapper = mountComponent();
      const store = useWebScraperStore(NODE_ID);
      store.setSandboxUrl(SANDBOX_URL);
      checkScraper.mockResolvedValue(buildResult());

      // 2. Act
      await store.runSandboxTest();
      await wrapper.vm.$nextTick();

      // 3. Assert
      expect(wrapper.find('[data-test="sandbox-result"]').exists()).toBe(true);
      expect(wrapper.text()).toContain('Titular de la nota');
      expect(wrapper.text()).toContain('Sin firma');
    });
  });

  describe('3. Aislamiento de capas', () => {
    it('3.1 no deberia llamar al servicio con solo montarse', () => {
      // 1. Arrange & 2. Act
      mountComponent();

      // 3. Assert: el componente no hace peticiones (regla §5); solo consume el
      //    store, y el store solo llama al servicio cuando el operador lo pide.
      expect(checkScraper).not.toHaveBeenCalled();
    });

    it('3.2 deberia montar la seccion con el nodeId recibido', () => {
      // 1. Arrange & 2. Act
      const wrapper = mountComponent();

      // 3. Assert: es el contrato uniforme del nodo (§3.1): el anfitrion pasa
      //    `nodeId` y nada mas.
      expect(wrapper.attributes('data-node-id')).toBe(NODE_ID);
    });
  });
});
