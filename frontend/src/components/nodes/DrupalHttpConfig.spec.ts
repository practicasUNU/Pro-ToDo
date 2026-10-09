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
  QTooltip,
  Quasar,
} from 'quasar';
import { beforeEach, describe, expect, it } from 'vitest';

import DrupalHttpConfig from '@components/nodes/DrupalHttpConfig.vue';
import { useDrupalHttpStore } from '@stores/nodes/drupal-http.store';

import { NodeType } from '@/types/pipeline';
import { DRUPAL_SANDBOX_PRESETS, DrupalOperationMode } from '@/types/nodes/drupal-http.types';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

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

const mountComponent = (nodeId: string): ReturnType<typeof mount> =>
  mount(DrupalHttpConfig, {
    props: { nodeId },
    // `Notify` se instala explicitamente: los botones de preset acusan recibo
    // con `$q.notify`, y sin el plugin `useQuasar()` devuelve un `$q` sin ese
    // metodo y el click revienta.
    global: {
      plugins: [[Quasar, { plugins: { Notify } }]],
      components: QUASAR_COMPONENTS,
    },
  });

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
      // 1. Arrange 📐: la barra se recorre sobre `DRUPAL_SANDBOX_PRESETS`, de
      //    modo que anadir un destino no obliga a tocar la plantilla. Esta
      //    prueba es la que lo sostiene: si alguien volviera a escribir los
      //    botones a mano, el recuento dejaria de cuadrar al anadir el cuarto.
      const wrapper = mountComponent(nextNodeId());

      // 3. Assert 🎯
      const botones = wrapper.findAll('[data-test^="preset-"]');
      expect(botones).toHaveLength(Object.keys(DRUPAL_SANDBOX_PRESETS).length);
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
      expect(notificationsSince(previas)).toContain('destino');
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
    expect(store.config.targetNodeUuid).toBe(
      DRUPAL_SANDBOX_PRESETS.ABRIR_LICITACION.targetNodeUuid,
    );
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
    expect(store.config.targetNodeUuid).toBe(
      DRUPAL_SANDBOX_PRESETS.VERIFICACION_TITULOS.targetNodeUuid,
    );
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
    expect(store.config.itemSelector).toBe('.licitacion-entry');
    expect(store.config.destinationNodeUuid).toBeNull();
    expect(store.isConfigValid).toBe(false);
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

    it('6.2 NO deberia pintar avisos mientras el contexto esta vacio', () => {
      // 1. Arrange 📐 & 2. Act ⚙️
      const wrapper = mountComponent(nextNodeId());

      // 3. Assert 🎯: avisar mientras carga el catalogo seria una falsa alarma
      //    en cada apertura del asistente.
      expect(wrapper.findAll('[data-test="config-warning"]')).toHaveLength(0);
    });
  });
});
