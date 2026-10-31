// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO, igual que en el resto de specs de componente: los de
// store no necesitan DOM y arrancan mas rapido sin el.
import { config, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  Notify,
  QBanner,
  QBtn,
  QCheckbox,
  QExpansionItem,
  QIcon,
  QInput,
  QSelect,
  QToggle,
  QTooltip,
  Quasar,
} from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DrupalHttpConfig from '@components/nodes/DrupalHttpConfig.vue';
import { NODE_SANDBOX_MODE_KEY } from '@components/nodes/node-sandbox-mode';
import VariableInsertButton from '@components/shared/VariableInsertButton.vue';
import { useDrupalHttpStore } from '@stores/nodes/drupal-http.store';

import { NodeType } from '@/types/pipeline';
import { DRUPAL_PRESETS, DrupalOperationMode } from '@/types/nodes/drupal-http.types';
import { fetchDrupalPresetTargets } from '@services/nodes/drupal-http.service';
import {
  DRUPAL_PRESET_TARGETS_FIXTURE,
  SANDBOX_LICITACIONES_UUID,
  SANDBOX_TITULOS_UUID,
} from '@/testing/drupal-preset-targets.fixture';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

// `@boot/axios` importa `#q-app`, que no existe fuera de Quasar.
vi.mock('@services/nodes/drupal-http.service', () => ({
  fetchDrupalPresetTargets: vi.fn(),
}));

/** `nodeId` unico por prueba: las definiciones de Pinia se memoizan por modulo. */
let nodeCounter = 0;
const nextNodeId = (): string => `destino_http_view_${(nodeCounter += 1)}`;

/**
 * Se registran a mano porque el plugin `Quasar` instala directivas y plugins
 * pero NO componentes.
 */
const QUASAR_COMPONENTS = {
  QBanner,
  QBtn,
  QCheckbox,
  QExpansionItem,
  QIcon,
  QInput,
  QSelect,
  QToggle,
  QTooltip,
};

const UPSTREAM: UpstreamNamespace[] = [
  {
    namespace: 'raw_email',
    nodeType: NodeType.TRIGGER_IMAP,
    fields: [{ name: 'attachments', type: 'object' }],
  },
  {
    namespace: 'validated_drupal_json',
    nodeType: NodeType.ESCUDO_POST_IA,
    fields: [
      { name: 'validated_markup', type: 'text' },
      { name: 'audit_status', type: 'text' },
    ],
  },
];

/**
 * Monta el configurador. Por defecto con las paginas de los destinos rapidos YA
 * cargadas en el store, para que un clic en un preset no dependa de una promesa
 * pendiente; las pruebas de la carga en si pasan `preloadTargets: false`.
 */
const mountComponent = (
  nodeId: string,
  inSandbox = false,
  preloadTargets = true,
): ReturnType<typeof mount> => {
  if (preloadTargets) {
    useDrupalHttpStore(nodeId).presetTargets = DRUPAL_PRESET_TARGETS_FIXTURE;
  }

  return mount(DrupalHttpConfig, {
    props: { nodeId },
    // `Notify` se instala explicitamente: los botones de preset acusan recibo
    // con `$q.notify`, y sin el plugin `useQuasar()` devuelve un `$q` sin ese
    // metodo y el click revienta.
    global: {
      plugins: [[Quasar, { plugins: { Notify } }]],
      components: QUASAR_COMPONENTS,
      // Lo que hace el Banco de Pruebas al montar un configurador.
      provide: inSandbox ? { [NODE_SANDBOX_MODE_KEY as symbol]: true } : {},
    },
  });
};

/**
 * El control de un campo, localizado por el `data-test` de su CONTENEDOR.
 *
 * Quasar derrama los atributos sobre un div interno, asi que marcar el propio
 * `q-select` no serviria para encontrarlo.
 */
/**
 * Deja que Quasar monte la notificacion.
 *
 * `Notify` se renderiza en un portal sobre `document.body` en un tick aparte,
 * asi que un `await trigger('click')` solo espera al ciclo del componente.
 */
const flushNotifications = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 60));
};

/** Notificaciones vivas en este instante, para poder diferenciar despues. */
const notificationSnapshot = (): Element[] =>
  Array.from(document.querySelectorAll('.q-notification'));

/**
 * Texto de las notificaciones que han aparecido DESDE `before`.
 *
 * Se compara contra una foto previa en vez de leer la ultima del DOM, y no es
 * remilgo: las notificaciones viven en `document.body` —fuera del wrapper—,
 * duran varios segundos y Quasar las agrupa por tipo y posicion, de modo que el
 * orden del DOM no es el de emision. Una 'warning' de una prueba anterior puede
 * quedar por detras de la 'positive' de esta.
 *
 * Tampoco se barren a mano entre pruebas: Quasar mantiene su propia lista y su
 * portal, y arrancar los nodos por debajo lo desincroniza hasta el punto de que
 * las siguientes ya no llegan a montarse.
 */
const notificationsSince = (before: Element[]): string =>
  notificationSnapshot()
    .filter((node) => !before.includes(node))
    .map((node) => node.textContent ?? '')
    .join(' | ');

const selectByField = (wrapper: ReturnType<typeof mount>, field: string) =>
  wrapper.get(`[data-test="${field}"]`).findComponent(QSelect);

const inputByField = (wrapper: ReturnType<typeof mount>, field: string) =>
  wrapper.get(`[data-test="${field}"]`).findComponent(QInput);

describe('DrupalHttpConfig · configurador del nodo DESTINO_DRUPAL', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    config.global.plugins = [];
  });

  describe('1. Montaje', () => {
    it('1.1 deberia identificar el nodo que configura', () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();

      // 2. Act ⚙️
      const wrapper = mountComponent(nodeId);

      // 3. Assert 🎯
      expect(wrapper.get('section').attributes('data-node-id')).toBe(nodeId);
    });

    it('1.2 deberia avisar de que el nodo cierra el flujo', () => {
      // 1. Arrange 📐 & 2. Act ⚙️
      const wrapper = mountComponent(nextNodeId());

      // 3. Assert 🎯: nada corre despues, y eso cambia como se lee un fallo aqui.
      expect(wrapper.get('[data-test="destination-notice"]').text()).toContain('cierra el flujo');
    });
  });

  describe('2. Secciones condicionales por modo de operacion', () => {
    it('2.1 deberia pedir titulo y resumen en CREATE_NODE', () => {
      // 1. Arrange 📐: es el modo por defecto.
      const wrapper = mountComponent(nextNodeId());

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(wrapper.find('[data-test="title-template-field"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="summary-template-field"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="target-uuid-field"]').exists()).toBe(false);
    });

    it('2.2 deberia pedir contenedor y posicion en APPEND_HTML_BLOCK', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      useDrupalHttpStore(nodeId).updateConfig({
        operationMode: DrupalOperationMode.APPEND_HTML_BLOCK,
      });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="target-uuid-field"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="container-selector-field"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="insert-position-field"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="title-template-field"]').exists()).toBe(false);
    });

    /**
     * El banner y el ocultamiento son UNA sola pieza: el cartel explica por que
     * los campos no estan. Por eso cada caso afirma las dos cosas a la vez — si
     * alguien reintrodujera el titulo en un modo agregador, el banner pasaria a
     * mentir ("no requiere titulo") y una prueba que solo mirase el cartel lo
     * dejaria pasar.
     */
    it('2.1bis deberia explicar la ausencia de titulo en APPEND_HTML_BLOCK', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      useDrupalHttpStore(nodeId).updateConfig({
        operationMode: DrupalOperationMode.APPEND_HTML_BLOCK,
      });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="aggregator-notice"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="title-template-field"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="summary-template-field"]').exists()).toBe(false);
    });

    it('2.1ter deberia explicar la ausencia de titulo tambien en TRANSFER_HTML_BLOCK', async () => {
      // 1. Arrange 📐: trasladar un bloque tampoco da de alta una entidad.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      useDrupalHttpStore(nodeId).updateConfig({
        operationMode: DrupalOperationMode.TRANSFER_HTML_BLOCK,
      });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="aggregator-notice"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="title-template-field"]').exists()).toBe(false);
    });

    it('2.1quater NO deberia anunciar el modo agregador en CREATE_NODE ni al subir un fichero', async () => {
      // 1. Arrange 📐: CREATE_NODE es el modo por defecto.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️ & 3. Assert 🎯: con el titulo en pantalla, el cartel se
      //    contradiria con el formulario que tiene debajo.
      expect(wrapper.find('[data-test="aggregator-notice"]').exists()).toBe(false);

      // 2bis. Act ⚙️: UPLOAD_ATTACHMENT tampoco crea contenido, pero sube un
      //    binario a un campo SIN tocar el marcado de la pagina. Prometer una
      //    insercion en el HTML seria falso.
      useDrupalHttpStore(nodeId).updateConfig({
        operationMode: DrupalOperationMode.UPLOAD_ATTACHMENT,
      });
      await wrapper.vm.$nextTick();

      // 3bis. Assert 🎯
      expect(wrapper.find('[data-test="aggregator-notice"]').exists()).toBe(false);
    });

    it('2.2bis deberia revelar la lista de pliegos solo al encender la subida', async () => {
      // 1. Arrange 📐: el selector solo significa algo si hay fichero que
      //    colgar de el. Mostrarlo siempre invitaria a configurarlo en modos que
      //    ni lo leen.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useDrupalHttpStore(nodeId);

      // 2. Act ⚙️
      store.updateConfig({ operationMode: DrupalOperationMode.APPEND_HTML_BLOCK });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯: la casilla esta, el selector todavia no.
      expect(wrapper.find('[data-test="upload-attachment-field"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="attachment-list-selector-field"]').exists()).toBe(false);

      store.updateConfig({ uploadAttachment: true });
      await wrapper.vm.$nextTick();

      expect(wrapper.find('[data-test="attachment-list-selector-field"]').exists()).toBe(true);
    });

    it('2.2ter NO deberia ofrecer la subida en los modos que no insertan bloque', async () => {
      // 1. Arrange 📐: CREATE_NODE crea una entidad, no aumenta una pagina.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      useDrupalHttpStore(nodeId).updateConfig({
        operationMode: DrupalOperationMode.CREATE_NODE,
      });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="upload-attachment-field"]').exists()).toBe(false);
    });

    it('2.3 deberia pedir los dos identificadores y el selector en TRANSFER_HTML_BLOCK', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      useDrupalHttpStore(nodeId).updateConfig({
        operationMode: DrupalOperationMode.TRANSFER_HTML_BLOCK,
      });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="target-uuid-field"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="destination-uuid-field"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="item-selector-field"]').exists()).toBe(true);
    });

    it('2.4 deberia ocultar el origen del markup en TRANSFER_HTML_BLOCK', async () => {
      // 1. Arrange 📐: ese modo no lee el contexto; el bloque sale del DOM
      //    remoto. Pedir un namespace que no se usa invita a configurarlo mal.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      expect(wrapper.find('[data-test="source-namespace-field"]').exists()).toBe(true);

      // 2. Act ⚙️
      useDrupalHttpStore(nodeId).updateConfig({
        operationMode: DrupalOperationMode.TRANSFER_HTML_BLOCK,
      });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="source-namespace-field"]').exists()).toBe(false);
    });

    it('2.5 deberia advertir de la caducidad de los bytes en UPLOAD_ATTACHMENT', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      useDrupalHttpStore(nodeId).updateConfig({
        operationMode: DrupalOperationMode.UPLOAD_ATTACHMENT,
      });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.get('[data-test="attachment-notice"]').text()).toContain('ANTES del parser');
    });
  });

  describe('3. Selectores cerrados (Poka-Yoke §4)', () => {
    it('3.1 deberia deshabilitar el origen sin contexto aguas arriba', () => {
      // 1. Arrange 📐 & 2. Act ⚙️
      const wrapper = mountComponent(nextNodeId());

      // 3. Assert 🎯: ofrecer un desplegable vacio sugiere que no hay nada que
      //    elegir; deshabilitado dice que todavia no se puede.
      expect(selectByField(wrapper, 'source-namespace-field').props('disable')).toBe(true);
    });

    it('3.2 deberia ofrecer los namespaces que publican los pasos anteriores', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      useDrupalHttpStore(nodeId).setAvailableUpstreamContext(UPSTREAM);
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(selectByField(wrapper, 'source-namespace-field').props('options')).toEqual([
        'raw_email',
        'validated_drupal_json',
      ]);
    });

    it('3.3 deberia ofrecer los campos del namespace elegido', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      useDrupalHttpStore(nodeId).setAvailableUpstreamContext(UPSTREAM);
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(selectByField(wrapper, 'source-field-field').props('options')).toEqual([
        'validated_markup',
        'audit_status',
      ]);
    });

    it('3.4 deberia conservar un bundle heredado fuera del catalogo', async () => {
      // 1. Arrange 📐: vaciarlo en silencio romperia un flujo que funcionaba.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      useDrupalHttpStore(nodeId).updateConfig({ bundle: 'taxonomy_term--etiquetas' });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(selectByField(wrapper, 'bundle-field').props('options')).toContain(
        'taxonomy_term--etiquetas',
      );
    });
  });

  describe('4. Enlace con el store', () => {
    it('4.1 deberia escribir el modo elegido', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useDrupalHttpStore(nodeId);

      // 2. Act ⚙️
      selectByField(wrapper, 'operation-mode-field').vm.$emit(
        'update:model-value',
        DrupalOperationMode.UPLOAD_ATTACHMENT,
      );
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(store.config.operationMode).toBe(DrupalOperationMode.UPLOAD_ATTACHMENT);
    });

    it('4.2 deberia tratar un titulo en blanco como ausencia', async () => {
      // 1. Arrange 📐: el backend resuelve con `trimmedOrNull`, y mostrar como
      //    configurado lo que el motor vera vacio deja el paso en falso verde.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useDrupalHttpStore(nodeId);

      // 2. Act ⚙️
      inputByField(wrapper, 'title-template-field').vm.$emit('update:model-value', '   ');
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(store.config.titleTemplate).toBeNull();
      expect(store.isConfigValid).toBe(false);
    });

    it('4.3 deberia desactivar la publicacion automatica desde el acordeon', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useDrupalHttpStore(nodeId);

      // 2. Act ⚙️
      wrapper
        .get('[data-test="publish-status-field"]')
        .findComponent(QCheckbox)
        .vm.$emit('update:model-value', false);
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(store.config.publishStatus).toBe(false);
      expect(store.toNodeParams().publishStatus).toBe(false);
    });
  });

  /**
   * ORDEN DELIBERADO: las dos pruebas de notificacion van ANTES que las de
   * configuracion.
   *
   * Quasar AGRUPA las notificaciones identicas: la segunda vez que se emite el
   * mismo mensaje no monta un elemento nuevo, reutiliza el existente e
   * incrementa su contador. Como varios presets comparten el texto de acuse, si
   * estas pruebas fueran las ultimas no habria nodo nuevo que observar y la
   * comprobacion no distinguiria «notifico» de «no notifico».
   */
  describe('5. Presets de destinos operativos', () => {
    it('5.1 deberia pintar un boton por cada destino del catalogo', () => {
      // 1. Arrange 📐: la barra se recorre sobre `DRUPAL_PRESETS`, de
      //    modo que anadir un destino no obliga a tocar la plantilla. Esta
      //    prueba es la que lo sostiene: si alguien volviera a escribir los
      //    botones a mano, el recuento dejaria de cuadrar al anadir el cuarto.
      const wrapper = mountComponent(nextNodeId());

      // 3. Assert 🎯
      const botones = wrapper.findAll('[data-test^="preset-"]');
      expect(botones).toHaveLength(Object.keys(DRUPAL_PRESETS).length);
      expect(wrapper.find('[data-test="preset-abrir_licitacion"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="preset-cerrar_licitacion"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="preset-verificacion_titulos"]').exists()).toBe(true);
    });

    it('5.2 deberia acusar recibo del preset con una notificacion', async () => {
      // 1. Arrange 📐: un preset escribe siete campos repartidos por secciones
      //    que pueden estar plegadas. Sin el acuse, el unico indicio visible de
      //    que el boton hizo algo seria el UUID.
      //
      //    Se afirma sobre el DOM y no sobre un espia de `Notify.create`: el
      //    plugin asigna `$q.notify` en el install y el componente captura esa
      //    referencia en su `setup`, de modo que un espia puesto despues no la
      //    intercepta —y una prueba que no intercepta nada pasa igual sin
      //    comprobar nada.
      const wrapper = mountComponent(nextNodeId());
      const previas = notificationSnapshot();

      // 2. Act ⚙️
      await wrapper.get('[data-test="preset-abrir_licitacion"]').trigger('click');
      await flushNotifications();

      // 3. Assert 🎯
      expect(notificationsSince(previas)).toContain('Preset cargado');
    });

    it('5.3 deberia avisar de que el traslado queda a medias', async () => {
      // 1. Arrange 📐: sin este aviso el operador lee el asterisco del campo de
      //    destino como un fallo del boton y vuelve a pulsarlo.
      const wrapper = mountComponent(nextNodeId());
      const previas = notificationSnapshot();

      // 2. Act ⚙️
      await wrapper.get('[data-test="preset-cerrar_licitacion"]').trigger('click');
      await flushNotifications();

      // 3. Assert 🎯
      expect(notificationsSince(previas)).toContain('UUID');
    });
  });

  it('5.4 deberia rellenar el destino de apertura de una sola vez', async () => {
    // 1. Arrange 📐: teclear un UUID v4 a mano es el error mas caro de este
    //    formulario —un digito cambiado pasa la validacion y falla en
    //    ejecucion con un 404 de Drupal y el flujo ya PAUSADO.
    const nodeId = nextNodeId();
    const wrapper = mountComponent(nodeId);
    const store = useDrupalHttpStore(nodeId);

    // 2. Act ⚙️
    await wrapper.get('[data-test="preset-abrir_licitacion"]').trigger('click');
    await flushNotifications();

    // 3. Assert 🎯
    expect(store.config.targetNodeUuid).toBe(SANDBOX_LICITACIONES_UUID);
    expect(store.config.bundle).toBe('node--page');
    expect(store.config.operationMode).toBe(DrupalOperationMode.APPEND_HTML_BLOCK);
  });

  it('5.5 deberia cargar el panel de titulos en la pagina agregadora', async () => {
    // 1. Arrange 📐
    const nodeId = nextNodeId();
    const wrapper = mountComponent(nodeId);
    const store = useDrupalHttpStore(nodeId);

    // 2. Act ⚙️
    await wrapper.get('[data-test="preset-verificacion_titulos"]').trigger('click');
    await flushNotifications();

    // 3. Assert 🎯
    expect(store.config.targetNodeUuid).toBe(SANDBOX_TITULOS_UUID);
    expect(store.config.bundle).toBe('node--page');
    expect(store.config.operationMode).toBe(DrupalOperationMode.APPEND_HTML_BLOCK);
  });

  it('5.6 deberia cargar el traslado dejando el destino pendiente', async () => {
    // 1. Arrange 📐: el campo se queda vacio A PROPOSITO, porque la pagina de
    //    cerradas no tiene UUID conocido. Lo que esta prueba vigila es que el
    //    boton SI haga el resto del trabajo: si no escribiera el selector,
    //    «no hace nada» y «hace lo que puede» se verian igual en pantalla.
    const nodeId = nextNodeId();
    const wrapper = mountComponent(nodeId);
    const store = useDrupalHttpStore(nodeId);

    // 2. Act ⚙️
    await wrapper.get('[data-test="preset-cerrar_licitacion"]').trigger('click');
    await flushNotifications();

    // 3. Assert 🎯
    expect(store.config.operationMode).toBe(DrupalOperationMode.TRANSFER_HTML_BLOCK);
    expect(store.config.itemSelector).toBe('.pd-licitacion-block, .licitacion-entry');
    expect(store.config.destinationNodeUuid).toBeNull();
    expect(store.isConfigValid).toBe(false);
  });
  describe('5bis. Entorno y presets ordenados', () => {
    it('should render Innodays preset button positioned strictly between Verificación de títulos and Notiweb', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = mountComponent(nextNodeId());

      // 3. Assert 🎯: el orden exacto de la barra, y cada boton con su entorno.
      const keys = wrapper
        .findAll('[data-test^="preset-"]')
        .map((button) => button.attributes('data-test'));
      expect(keys).toEqual([
        'preset-abrir_licitacion',
        'preset-cerrar_licitacion',
        'preset-verificacion_titulos',
        'preset-innodays',
        'preset-innobar',
        'preset-notiweb',
      ]);
      expect(wrapper.get('[data-test="preset-innodays"]').text()).toContain('Innodays (Sandbox)');
    });

    it('5bis.2 deberia rotular los presets como Produccion al apagar el toggle', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      wrapper.findComponent(QToggle).vm.$emit('update:modelValue', false);
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(useDrupalHttpStore(nodeId).config.isSandbox).toBe(false);
      expect(wrapper.get('[data-test="preset-notiweb"]').text()).toContain('Notiweb (Producción)');
    });

    it('should disable environment selection and lock to sandbox when rendered in sandbox mode', async () => {
      // 1. Arrange 📐: un nodo que llega configurado contra Produccion.
      const nodeId = nextNodeId();
      useDrupalHttpStore(nodeId).setSandbox(false);

      // 2. Act ⚙️
      const wrapper = mountComponent(nodeId, true);
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯: forzado a Sandbox, toggle bloqueado y el motivo a la vista.
      const toggle = wrapper.findComponent(QToggle);
      expect(useDrupalHttpStore(nodeId).config.isSandbox).toBe(true);
      expect(toggle.props('disable')).toBe(true);
      expect(toggle.props('modelValue')).toBe(true);
      expect(wrapper.get('[data-test="sandbox-lock-notice"]').text()).toContain(
        'En el Banco de Pruebas solo está permitido ejecutar sobre el entorno Sandbox',
      );
      expect(wrapper.get('[data-test="preset-abrir_licitacion"]').text()).toContain('(Sandbox)');
    });

    it('5bis.4 deberia pedir selector, atributo y valor en el modo enlace', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      await wrapper.get('[data-test="preset-innodays"]').trigger('click');
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="link-selector-field"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="link-attribute-field"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="link-value-field"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="target-uuid-field"]').exists()).toBe(true);
    });
  });

  describe('5ter. Innobar y borrador en Sandbox', () => {
    it('should render Innobar preset button between Innodays and Notiweb', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = mountComponent(nextNodeId());

      // 3. Assert 🎯
      const keys = wrapper
        .findAll('[data-test^="preset-"]')
        .map((button) => button.attributes('data-test'));
      const innobar = keys.indexOf('preset-innobar');
      expect(keys[innobar - 1]).toBe('preset-innodays');
      expect(keys[innobar + 1]).toBe('preset-notiweb');
      expect(wrapper.get('[data-test="preset-innobar"]').text()).toContain('Innobar (Sandbox)');
    });

    it('should set separate production URLs for Innodays (/innodays-madrid) and Innobar (/innobar-madrid)', () => {
      // 1. Arrange 📐
      const innodays = DRUPAL_PRESETS.INNODAYS.environments;
      const innobar = DRUPAL_PRESETS.INNOBAR.environments;

      // 2. Act ⚙️ + 3. Assert 🎯: en pruebas comparten pagina; en el portal no.
      expect(innodays.SANDBOX.path).toBe('/prueba-innodays');
      expect(innobar.SANDBOX.path).toBe('/prueba-innodays');
      expect(innodays.PRODUCTION.path).toBe('/innodays-madrid');
      expect(innobar.PRODUCTION.path).toBe('/innobar-madrid');
    });

    it('5ter.2bis deberia cargar Innobar con el modo de enlace', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      useDrupalHttpStore(nodeId).setSandbox(false);

      // 2. Act ⚙️
      await wrapper.get('[data-test="preset-innobar"]').trigger('click');

      // 3. Assert 🎯
      const store = useDrupalHttpStore(nodeId);
      expect(store.config.operationMode).toBe(DrupalOperationMode.UPDATE_LINK_SOURCE);
      expect(store.activePresetKey).toBe('INNOBAR');
    });

    it('should disable publish toggle and force false state when in sandbox mode', async () => {
      // 1. Arrange 📐: un nodo que publicaba en Produccion se abre en el banco.
      const nodeId = nextNodeId();
      const store = useDrupalHttpStore(nodeId);
      store.setSandbox(false);
      store.updateConfig({ publishStatus: true });

      // 2. Act ⚙️
      const wrapper = mountComponent(nodeId, true);
      await wrapper.vm.$nextTick();
      store.updateConfig({ publishStatus: true });

      // 3. Assert 🎯: borrador forzado, control bloqueado y la nota a la vista.
      const toggle = wrapper.get('[data-test="publish-status-field"]').findComponent(QCheckbox);
      expect(store.config.isSandbox).toBe(true);
      expect(store.config.publishStatus).toBe(false);
      expect(toggle.props('disable')).toBe(true);
      expect(wrapper.get('[data-test="sandbox-draft-notice"]').text()).toContain(
        'En Sandbox el contenido siempre se guarda como borrador despublicado (status = false)',
      );
    });
  });

  describe('6. Avisos', () => {
    it('6.1 deberia pintar los avisos que levanta el store', async () => {
      // 1. Arrange 📐: un flujo sin escudo delante no publica el namespace que
      //    este nodo lee por defecto.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      useDrupalHttpStore(nodeId).setAvailableUpstreamContext([
        { namespace: 'raw_email', nodeType: NodeType.TRIGGER_IMAP, fields: [] },
      ]);
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      const warnings = wrapper.findAll('[data-test="config-warning"]');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.text()).toContain('validated_drupal_json');
    });

    it('6.3 deberia explicar el despacho jerarquico SOLO en el modo agregador', async () => {
      // 1. Arrange 📐: es lo que lo distingue del `aggregator-notice` de al
      //    lado, y la razon de que sean dos banners y no uno. Aquel se muestra
      //    con `mutatesRemoteDom`, que cubre tambien el traslado; el reparto por
      //    universidad solo ocurre en APPEND_HTML_BLOCK, de modo que un texto
      //    unico mentiria en el otro modo.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useDrupalHttpStore(nodeId);

      // 2. Act ⚙️ & 3. Assert 🎯: en CREATE_NODE, que es el defecto, no sale.
      expect(wrapper.find('[data-test="hierarchical-dispatch-notice"]').exists()).toBe(false);

      // 2bis. Act ⚙️
      store.updateConfig({ operationMode: DrupalOperationMode.APPEND_HTML_BLOCK });
      await wrapper.vm.$nextTick();

      // 3bis. Assert 🎯: y nombra el reparto, porque su texto es la unica
      //    explicacion que el operador recibe de el.
      const notice = wrapper.find('[data-test="hierarchical-dispatch-notice"]');

      expect(notice.exists()).toBe(true);
      expect(notice.text()).toContain('data-parent');

      // 2ter. Act ⚙️: el traslado SI muestra el otro banner, pero no este.
      store.updateConfig({ operationMode: DrupalOperationMode.TRANSFER_HTML_BLOCK });
      await wrapper.vm.$nextTick();

      // 3ter. Assert 🎯
      expect(wrapper.find('[data-test="aggregator-notice"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="hierarchical-dispatch-notice"]').exists()).toBe(false);
    });

    it('6.2 NO deberia pintar avisos mientras el contexto esta vacio', () => {
      // 1. Arrange 📐 & 2. Act ⚙️
      const wrapper = mountComponent(nextNodeId());

      // 3. Assert 🎯: avisar mientras carga el catalogo seria una falsa alarma
      //    en cada apertura del asistente.
      expect(wrapper.findAll('[data-test="config-warning"]')).toHaveLength(0);
    });
  });

  describe('7. Contenedor de destino, Notiweb y variables', () => {
    it('should render targetContainerSelector input field when mode is TRANSFER_HTML_BLOCK', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useDrupalHttpStore(nodeId);
      expect(wrapper.find('[data-test="target-container-selector-field"]').exists()).toBe(false);

      // 2. Act ⚙️
      store.applyCerrarLicitacionPreset();
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯: visible y con el panel de cerradas que trae el preset.
      const field = wrapper.find('[data-test="target-container-selector-field"]');

      expect(field.exists()).toBe(true);
      expect(field.text()).toContain('Contenedor de destino (Selector CSS)');
      expect(field.find('input').element.value).toBe('#collapse2 > .panel-body');
    });

    it('7.2 deberia escribir en el store el contenedor de destino tecleado', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useDrupalHttpStore(nodeId);
      store.updateConfig({ operationMode: DrupalOperationMode.TRANSFER_HTML_BLOCK });
      await wrapper.vm.$nextTick();

      // 2. Act ⚙️
      await wrapper
        .find('[data-test="target-container-selector-field"]')
        .findComponent(QInput)
        .setValue('#collapse3 .panel-body');

      // 3. Assert 🎯
      expect(store.config.targetContainerSelector).toBe('#collapse3 .panel-body');
    });

    it('7.3 deberia pintar autor, fecha, orden y taxonomias solo en el bundle de noticias', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useDrupalHttpStore(nodeId);

      // 2. Act ⚙️
      store.applyNotiwebPreset();
      await wrapper.vm.$nextTick();
      const withNews = wrapper.find('[data-test="news-section-term-field"]').exists();
      store.updateConfig({ bundle: 'node--page' });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(withNews).toBe(true);
      expect(wrapper.find('[data-test="author-template-field"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="news-section-term-field"]').exists()).toBe(false);
    });

    it('7.4 deberia insertar el marcador elegido en el titulo', async () => {
      // 1. Arrange 📐: el campo nunca tuvo el foco, asi que va al final.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useDrupalHttpStore(nodeId);
      store.setAvailableUpstreamContext(UPSTREAM);
      store.updateConfig({ titleTemplate: 'Noticia: ' });
      await wrapper.vm.$nextTick();

      // 2. Act ⚙️
      wrapper
        .find('[data-test="title-template-field"]')
        .findComponent(VariableInsertButton)
        .vm.$emit('insert', '{{validated_drupal_json.audit_status}}');
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(store.config.titleTemplate).toBe('Noticia: {{validated_drupal_json.audit_status}}');
    });

    it('7.5 deberia ofrecer variables en el selector y en el valor del enlace', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      useDrupalHttpStore(nodeId).applyInnobarPreset();
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      for (const testId of ['link-selector-field', 'link-value-field']) {
        expect(
          wrapper.find(`[data-test="${testId}"]`).findComponent(VariableInsertButton).exists(),
        ).toBe(true);
      }
    });
  });

  describe('8. Paginas del backend, traslado y autor de respaldo', () => {
    it('8.1 deberia pedir las paginas al montar y rellenar el preset con ellas', async () => {
      // 1. Arrange 📐: sin precarga, como en la aplicacion real.
      vi.mocked(fetchDrupalPresetTargets).mockClear();
      vi.mocked(fetchDrupalPresetTargets).mockResolvedValue(DRUPAL_PRESET_TARGETS_FIXTURE);
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId, false, false);
      await flushNotifications();

      // 2. Act ⚙️
      await wrapper.get('[data-test="preset-verificacion_titulos"]').trigger('click');

      // 3. Assert 🎯
      expect(fetchDrupalPresetTargets).toHaveBeenCalledTimes(1);
      expect(useDrupalHttpStore(nodeId).config.targetNodeUuid).toBe(SANDBOX_TITULOS_UUID);
    });

    it('8.2 deberia avisar si no se pueden cargar las paginas, sin bloquear el formulario', async () => {
      // 1. Arrange 📐
      vi.mocked(fetchDrupalPresetTargets).mockRejectedValue(new Error('503'));
      const before = notificationSnapshot().length;

      // 2. Act ⚙️
      const wrapper = mountComponent(nextNodeId(), false, false);
      await flushNotifications();

      // 3. Assert 🎯
      const fresh = notificationSnapshot().slice(before);
      expect(fresh.some((node) => node.textContent?.includes('No se pudieron cargar'))).toBe(true);
      expect(wrapper.find('[data-test="preset-abrir_licitacion"]').exists()).toBe(true);
    });

    it('8.3 deberia dejar elegir la posicion de insercion tambien en el traslado', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useDrupalHttpStore(nodeId);

      // 2. Act ⚙️
      store.applyCerrarLicitacionPreset();
      await wrapper.vm.$nextTick();
      wrapper
        .get('[data-test="insert-position-field"]')
        .findComponent(QSelect)
        .vm.$emit('update:model-value', 'APPEND');
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯: PREPEND por defecto en el preset, APPEND al elegirlo.
      expect(store.config.insertPosition).toBe('APPEND');
      expect(store.toNodeParams()).toMatchObject({ insertPosition: 'APPEND' });
    });

    it('8.4 deberia ofrecer variables en el selector del bloque a trasladar', async () => {
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      useDrupalHttpStore(nodeId).applyCerrarLicitacionPreset();
      await wrapper.vm.$nextTick();

      expect(
        wrapper
          .get('[data-test="item-selector-field"]')
          .findComponent(VariableInsertButton)
          .exists(),
      ).toBe(true);
    });

    it('8.5 deberia pintar el autor de respaldo de Notiweb con su valor del preset', async () => {
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      useDrupalHttpStore(nodeId).applyNotiwebPreset();
      await wrapper.vm.$nextTick();

      expect(wrapper.get('[data-test="author-fallback-field"]').find('input').element.value).toBe(
        'Madrid+D',
      );
    });
  });
});
