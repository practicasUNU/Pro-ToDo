import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NodeType } from '@/types/pipeline';
import {
  DEFAULT_DRUPAL_ATTACHMENT_FIELD,
  DEFAULT_DRUPAL_ATTACHMENT_NAMESPACE,
  DEFAULT_DRUPAL_BODY_FIELD,
  DEFAULT_DRUPAL_BODY_FORMAT,
  DEFAULT_DRUPAL_BUNDLE,
  DEFAULT_DRUPAL_ATTACHMENT_LIST_SELECTOR,
  DEFAULT_DRUPAL_FILE_FIELD_NAME,
  DEFAULT_DRUPAL_SOURCE_FIELD,
  DEFAULT_DRUPAL_SOURCE_NAMESPACE,
  DRUPAL_PRESETS,
  DrupalOperationMode,
  MAX_DRUPAL_ATTACHMENT_INDEX,
  MAX_DRUPAL_SELECTOR_LENGTH,
  MAX_DRUPAL_TITLE_LENGTH,
} from '@/types/nodes/drupal-http.types';

import {
  DRUPAL_PRESET_TARGETS_FIXTURE,
  SANDBOX_LICITACIONES_UUID,
  SANDBOX_TITULOS_UUID,
} from '@/testing/drupal-preset-targets.fixture';

import { useDrupalHttpStore } from './drupal-http.store';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

/**
 * `nodeId` unico por prueba.
 *
 * Las definiciones de Pinia se memoizan en un `Map` de MODULO que sobrevive
 * entre pruebas, asi que reutilizar un id arrastraria el estado de la anterior.
 * `setActivePinia` reinicia las instancias, no el mapa de definiciones.
 */
// `@boot/axios` importa `#q-app`, que no existe fuera de Quasar.
vi.mock('@services/nodes/drupal-http.service', () => ({
  fetchDrupalPresetTargets: vi.fn(),
}));

let nodeCounter = 0;
const nextNodeId = (): string => `destino_http_${(nodeCounter += 1)}`;

/**
 * Store con las paginas de los destinos rapidos ya cargadas, como las dejaria
 * el componente al montarse tras `GET /api/nodos/drupal/targets`.
 */
const buildStore = (): ReturnType<typeof useDrupalHttpStore> => {
  const store = useDrupalHttpStore(nextNodeId());
  store.presetTargets = DRUPAL_PRESET_TARGETS_FIXTURE;

  return store;
};

/** UUID v4 validos, para no depender de literales repetidos por el archivo. */
const SOURCE_UUID = SANDBOX_LICITACIONES_UUID;
const DESTINATION_UUID = '3b9f5c21-7d84-4a6e-9c13-2f8e5a0d4b77';

/** Contexto tipico de un flujo completo: escudo delante del destino. */
const FULL_UPSTREAM: UpstreamNamespace[] = [
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

describe('useDrupalHttpStore · configuracion del nodo DESTINO_DRUPAL', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  describe('1. Estado inicial', () => {
    it('1.1 deberia arrancar con los mismos defectos que resuelve el DTO', () => {
      // 1. Arrange 📐
      const store = buildStore();

      // 2. Act ⚙️ & 3. Assert 🎯: la replica tiene que coincidir campo a campo,
      //    o la interfaz mostraria una configuracion distinta de la que corre.
      expect(store.config).toEqual({
        isSandbox: true,
        operationMode: DrupalOperationMode.CREATE_NODE,
        bundle: DEFAULT_DRUPAL_BUNDLE,
        sourceNamespace: DEFAULT_DRUPAL_SOURCE_NAMESPACE,
        sourceField: DEFAULT_DRUPAL_SOURCE_FIELD,
        titleTemplate: null,
        summaryTemplate: null,
        authorTemplate: null,
        authorFallback: null,
        dateTemplate: null,
        orderValue: 1,
        newsSourceTermUuid: null,
        newsSectionTermUuid: null,
        newsTypeTermUuid: null,
        bodyFieldName: DEFAULT_DRUPAL_BODY_FIELD,
        bodyFormat: DEFAULT_DRUPAL_BODY_FORMAT,
        // Nace en Sandbox, donde lo creado es siempre borrador.
        publishStatus: false,
        targetNodeUuid: null,
        destinationNodeUuid: null,
        containerSelector: null,
        itemSelector: null,
        targetContainerSelector: null,
        insertPosition: 'PREPEND',
        expedienteTemplate: null,
        linkSelector: null,
        linkAttribute: 'href',
        linkValueTemplate: null,
        attachmentNamespace: DEFAULT_DRUPAL_ATTACHMENT_NAMESPACE,
        attachmentField: DEFAULT_DRUPAL_ATTACHMENT_FIELD,
        attachmentIndex: 0,
        fileFieldName: DEFAULT_DRUPAL_FILE_FIELD_NAME,
        uploadAttachment: false,
        attachmentListSelector: DEFAULT_DRUPAL_ATTACHMENT_LIST_SELECTOR,
      });
    });

    it('1.2 NO deberia nacer valido: el modo por defecto exige un titulo', () => {
      // 1. Arrange 📐
      const store = buildStore();

      // 2. Act ⚙️ & 3. Assert 🎯: a diferencia del escudo, cuyo DTO admite
      //    `params: {}` ejecutables, este nodo no puede publicar sin titulo.
      expect(store.isConfigValid).toBe(false);
      expect(store.missingRequiredParams).toEqual(['titleTemplate']);
    });

    it('1.3 deberia aislar la configuracion entre dos nodos del mismo tipo', () => {
      // 1. Arrange 📐: un flujo puede crear la noticia Y cerrar su licitacion.
      const first = buildStore();
      const second = buildStore();

      // 2. Act ⚙️
      first.updateConfig({ bundle: 'node--page' });

      // 3. Assert 🎯
      expect(second.config.bundle).toBe(DEFAULT_DRUPAL_BUNDLE);
    });
  });

  describe('2. Validez por modo de operacion', () => {
    it('2.1 CREATE_NODE deberia ser valido con solo el titulo', () => {
      // 1. Arrange 📐
      const store = buildStore();

      // 2. Act ⚙️
      store.updateConfig({ titleTemplate: '{{validated_drupal_json.headline}}' });

      // 3. Assert 🎯: `bundle` NO se exige aparte porque su defecto no es vacio;
      //    pedirlo seria una condicion que no puede fallar nunca.
      expect(store.isConfigValid).toBe(true);
    });

    it('2.2 APPEND_HTML_BLOCK deberia exigir el identificador de la pagina', () => {
      // 1. Arrange 📐
      const store = buildStore();

      // 2. Act ⚙️
      store.updateConfig({ operationMode: DrupalOperationMode.APPEND_HTML_BLOCK });

      // 3. Assert 🎯
      expect(store.missingRequiredParams).toEqual(['targetNodeUuid']);
      expect(store.isConfigValid).toBe(false);

      store.updateConfig({ targetNodeUuid: SOURCE_UUID });
      expect(store.isConfigValid).toBe(true);
    });

    it('2.3 TRANSFER_HTML_BLOCK deberia exigir origen, destino y selector', () => {
      // 1. Arrange 📐
      const store = buildStore();

      // 2. Act ⚙️
      store.updateConfig({ operationMode: DrupalOperationMode.TRANSFER_HTML_BLOCK });

      // 3. Assert 🎯: los tres a la vez. Mover un bloque sin saber cual, de
      //    donde o adonde no es una operacion a medias, es ninguna.
      expect(store.missingRequiredParams).toEqual([
        'targetNodeUuid',
        'destinationNodeUuid',
        'itemSelector',
      ]);

      store.updateConfig({
        targetNodeUuid: SOURCE_UUID,
        destinationNodeUuid: DESTINATION_UUID,
        itemSelector: '[data-expediente="S_2026_015"]',
      });
      expect(store.isConfigValid).toBe(true);
    });

    it('2.4 UPLOAD_ATTACHMENT deberia exigir solo el nodo anfitrion', () => {
      // 1. Arrange 📐
      const store = buildStore();

      // 2. Act ⚙️
      store.updateConfig({
        operationMode: DrupalOperationMode.UPLOAD_ATTACHMENT,
        targetNodeUuid: SOURCE_UUID,
      });

      // 3. Assert 🎯
      expect(store.missingRequiredParams).toEqual([]);
      expect(store.isConfigValid).toBe(true);
    });

    it('2.5 deberia reevaluar al cambiar de modo, sin arrastrar el juicio anterior', () => {
      // 1. Arrange 📐: valido como CREATE_NODE.
      const store = buildStore();
      store.updateConfig({ titleTemplate: 'Titular' });

      // 2. Act ⚙️: el mismo estado bajo otro modo pide otra cosa.
      store.updateConfig({ operationMode: DrupalOperationMode.APPEND_HTML_BLOCK });

      // 3. Assert 🎯
      expect(store.isConfigValid).toBe(false);
      expect(store.missingRequiredParams).toEqual(['targetNodeUuid']);
    });
  });

  describe('3. Formatos que el DTO rechazaria con un 400', () => {
    it('3.1 deberia invalidar un bundle sin el doble guion', () => {
      // 1. Arrange 📐
      const store = buildStore();
      store.updateConfig({ titleTemplate: 'Titular' });

      // 2. Act ⚙️: un solo guion es el error tipico, y el patron lo rechaza.
      store.updateConfig({ bundle: 'node-noticias' });

      // 3. Assert 🎯: sin esto, el 400 llegaria al guardar el flujo ENTERO, con
      //    el mensaje apuntando al esquema y no al campo.
      expect(store.malformedParams).toContain('bundle');
      expect(store.isConfigValid).toBe(false);
    });

    it('3.2 deberia invalidar un identificador que no sea UUID v4', () => {
      // 1. Arrange 📐
      const store = buildStore();

      // 2. Act ⚙️
      store.updateConfig({
        operationMode: DrupalOperationMode.APPEND_HTML_BLOCK,
        targetNodeUuid: '7f1700bf-b54b-1c12-b71a-8a71f1f0ee38',
      });

      // 3. Assert 🎯: la version `1` en el tercer grupo no es v4.
      expect(store.malformedParams).toContain('targetNodeUuid');
      expect(store.isConfigValid).toBe(false);
    });

    it('3.3 deberia aceptar un UUID v4 en mayusculas', () => {
      // 1. Arrange 📐: el patron del backend lleva la bandera `i`.
      const store = buildStore();

      // 2. Act ⚙️
      store.updateConfig({
        operationMode: DrupalOperationMode.APPEND_HTML_BLOCK,
        targetNodeUuid: SOURCE_UUID.toUpperCase(),
      });

      // 3. Assert 🎯
      expect(store.malformedParams).toEqual([]);
      expect(store.isConfigValid).toBe(true);
    });

    it('3.4 deberia invalidar un titulo mas largo de lo que admite Drupal', () => {
      // 1. Arrange 📐
      const store = buildStore();

      // 2. Act ⚙️
      store.updateConfig({ titleTemplate: 'x'.repeat(MAX_DRUPAL_TITLE_LENGTH + 1) });

      // 3. Assert 🎯
      expect(store.malformedParams).toContain('titleTemplate');
      expect(store.isConfigValid).toBe(false);
    });

    it('3.5 deberia invalidar un selector mas largo que el tope del DTO', () => {
      // 1. Arrange 📐
      const store = buildStore();

      // 2. Act ⚙️
      store.updateConfig({
        operationMode: DrupalOperationMode.TRANSFER_HTML_BLOCK,
        targetNodeUuid: SOURCE_UUID,
        destinationNodeUuid: DESTINATION_UUID,
        itemSelector: 'a'.repeat(MAX_DRUPAL_SELECTOR_LENGTH + 1),
      });

      // 3. Assert 🎯
      expect(store.malformedParams).toContain('itemSelector');
      expect(store.isConfigValid).toBe(false);
    });

    it('3.6 deberia invalidar un indice de adjunto fuera de rango', () => {
      // 1. Arrange 📐
      const store = buildStore();
      store.updateConfig({
        operationMode: DrupalOperationMode.UPLOAD_ATTACHMENT,
        targetNodeUuid: SOURCE_UUID,
      });

      // 2. Act ⚙️
      store.updateConfig({ attachmentIndex: MAX_DRUPAL_ATTACHMENT_INDEX + 1 });

      // 3. Assert 🎯
      expect(store.malformedParams).toContain('attachmentIndex');
      expect(store.isConfigValid).toBe(false);
    });

    it('3.7 deberia invalidar un nombre de campo que no sea snake_case', () => {
      // 1. Arrange 📐
      const store = buildStore();
      store.updateConfig({ titleTemplate: 'Titular' });

      // 2. Act ⚙️
      store.updateConfig({ bodyFieldName: 'Body Field' });

      // 3. Assert 🎯
      expect(store.malformedParams).toContain('bodyFieldName');
      expect(store.isConfigValid).toBe(false);
    });
  });

  describe('4. Selectores cerrados del contexto', () => {
    it('4.1 deberia ofrecer solo los namespaces de los pasos anteriores', () => {
      // 1. Arrange 📐
      const store = buildStore();

      // 2. Act ⚙️
      store.setAvailableUpstreamContext(FULL_UPSTREAM);

      // 3. Assert 🎯
      expect(store.namespaceOptions).toEqual(['raw_email', 'validated_drupal_json']);
    });

    it('4.2 deberia ofrecer los campos del namespace de origen elegido', () => {
      // 1. Arrange 📐: el defecto ya apunta a `validated_drupal_json`.
      const store = buildStore();

      // 2. Act ⚙️
      store.setAvailableUpstreamContext(FULL_UPSTREAM);

      // 3. Assert 🎯
      expect(store.fieldOptions).toEqual(['validated_markup', 'audit_status']);
    });

    it('4.3 deberia separar los campos del adjunto de los del markup', () => {
      // 1. Arrange 📐: son dos namespaces distintos y cada selector es suyo.
      const store = buildStore();

      // 2. Act ⚙️
      store.setAvailableUpstreamContext(FULL_UPSTREAM);

      // 3. Assert 🎯
      expect(store.attachmentFieldOptions).toEqual(['attachments']);
    });

    it('4.4 deberia copiar el contexto y no guardar la referencia del anfitrion', () => {
      // 1. Arrange 📐
      const store = buildStore();
      const context = [...FULL_UPSTREAM];

      // 2. Act ⚙️
      store.setAvailableUpstreamContext(context);
      context.pop();

      // 3. Assert 🎯: el anfitrion reconstruye su arreglo en cada sincronizacion.
      expect(store.namespaceOptions).toHaveLength(2);
    });
  });

  describe('5. Avisos no bloqueantes', () => {
    it('5.1 deberia avisar cuando nadie publica el namespace de origen', () => {
      // 1. Arrange 📐: hay escudo delante, pero publica una COPIA numerada y el
      //    origen sigue en el defecto.
      const store = buildStore();
      store.updateConfig({ titleTemplate: 'Titular' });

      // 2. Act ⚙️
      store.setAvailableUpstreamContext([
        { namespace: 'raw_email', nodeType: NodeType.TRIGGER_IMAP, fields: [] },
        {
          namespace: 'validated_drupal_json_2',
          nodeType: NodeType.ESCUDO_POST_IA,
          fields: [{ name: 'validated_markup', type: 'text' }],
        },
      ]);

      // 3. Assert 🎯: avisa y NO bloquea; el 400 de la regla 7 no nombra el
      //    campo del formulario y este mensaje si nombra el namespace.
      expect(store.configWarnings).toHaveLength(1);
      expect(store.configWarnings[0]).toContain(DEFAULT_DRUPAL_SOURCE_NAMESPACE);
      expect(store.isConfigValid).toBe(true);
    });

    it('5.2 NO deberia avisar mientras el contexto esta vacio', () => {
      // 1. Arrange 📐: el catalogo de nodos todavia no ha cargado.
      const store = buildStore();

      // 2. Act ⚙️ & 3. Assert 🎯: con el contexto vacio no se puede afirmar
      //    nada, y avisar seria una falsa alarma en cada apertura.
      expect(store.configWarnings).toEqual([]);
    });

    it('5.3 NO deberia avisar del origen en TRANSFER_HTML_BLOCK', () => {
      // 1. Arrange 📐: ese modo no lee el contexto, saca el bloque del DOM.
      const store = buildStore();

      // 2. Act ⚙️
      store.updateConfig({ operationMode: DrupalOperationMode.TRANSFER_HTML_BLOCK });
      store.setAvailableUpstreamContext([
        { namespace: 'raw_email', nodeType: NodeType.TRIGGER_IMAP, fields: [] },
      ]);

      // 3. Assert 🎯
      expect(store.configWarnings).toEqual([]);
    });

    it('5.4 deberia avisar de un parser por delante en UPLOAD_ATTACHMENT', () => {
      // 1. Arrange 📐: el motor libera los bytes del adjunto en cuanto un nodo
      //    publica texto, asi que el inventario llega con `contentBase64` nulo.
      const store = buildStore();

      // 2. Act ⚙️
      store.updateConfig({
        operationMode: DrupalOperationMode.UPLOAD_ATTACHMENT,
        targetNodeUuid: SOURCE_UUID,
      });
      store.setAvailableUpstreamContext([
        { namespace: 'raw_email', nodeType: NodeType.TRIGGER_IMAP, fields: [] },
        { namespace: 'parsed_email', nodeType: NodeType.PARSER_PRE_IA, fields: [] },
      ]);

      // 3. Assert 🎯: no se puede AFIRMAR que falle —depende de lo que publique
      //    el parser en ejecucion—, de modo que avisa en vez de bloquear.
      expect(store.configWarnings.some((warning) => warning.includes('PARSER_PRE_IA'))).toBe(true);
      expect(store.isConfigValid).toBe(true);
    });

    it('5.5 deberia avisar del parser tambien en un APPEND que sube el adjunto', () => {
      // 1. Arrange 📐: la regla 11 obliga a que el destino cierre el flujo, asi
      //    que la subida no puede ir en un nodo propio por delante del parser.
      //    Cabe en el APPEND, pero entonces depende de `skipDocumentExtraction`.
      const store = buildStore();

      // 2. Act ⚙️
      store.updateConfig({
        operationMode: DrupalOperationMode.APPEND_HTML_BLOCK,
        targetNodeUuid: SOURCE_UUID,
        uploadAttachment: true,
      });
      // El escudo va delante: sin el (ni procesador IA) el APPEND se bloquea.
      store.setAvailableUpstreamContext([
        { namespace: 'raw_email', nodeType: NodeType.TRIGGER_IMAP, fields: [] },
        { namespace: 'parsed_email', nodeType: NodeType.PARSER_PRE_IA, fields: [] },
        { namespace: 'validated_drupal_json', nodeType: NodeType.ESCUDO_POST_IA, fields: [] },
      ]);

      // 3. Assert 🎯: el texto del aviso es OTRO, porque el remedio tambien
      //    lo es: aqui no se puede mover el nodo, hay que tocar el parser.
      expect(
        store.configWarnings.some((warning) => warning.includes('skipDocumentExtraction')),
      ).toBe(true);
      expect(store.isConfigValid).toBe(true);
    });

    it('5.6 NO deberia avisar del parser si el APPEND no sube nada', () => {
      // 1. Arrange 📐: sin subida, los bytes del adjunto dan igual. Avisar
      //    aqui seria ruido en el caso mas comun del nodo.
      const store = buildStore();

      // 2. Act ⚙️
      store.updateConfig({
        operationMode: DrupalOperationMode.APPEND_HTML_BLOCK,
        targetNodeUuid: SOURCE_UUID,
      });
      store.setAvailableUpstreamContext([
        { namespace: 'parsed_email', nodeType: NodeType.PARSER_PRE_IA, fields: [] },
      ]);

      // 3. Assert 🎯
      expect(store.configWarnings.some((warning) => warning.includes('PARSER_PRE_IA'))).toBe(false);
    });
  });

  describe('6. Presets de destinos operativos', () => {
    it('6.1 deberia cargar los siete campos de ABRIR_LICITACION a la vez', () => {
      // 1. Arrange 📐: juntos o no significan nada. El UUID de la agregadora
      //    solo tiene sentido con `node--page` y un modo que mute HTML.
      const store = buildStore();
      const preset = DRUPAL_PRESETS.ABRIR_LICITACION;

      // 2. Act ⚙️
      store.applyAbrirLicitacionPreset();

      // 3. Assert 🎯
      expect(store.config.operationMode).toBe(DrupalOperationMode.APPEND_HTML_BLOCK);
      expect(store.config.bundle).toBe('node--page');
      expect(store.config.targetNodeUuid).toBe(SANDBOX_LICITACIONES_UUID);
      expect(store.config.destinationNodeUuid).toBeNull();
      // Contra el propio preset y no contra un literal: el selector del panel
      // desplegable es un dato del portal, y repetirlo aqui crearia una segunda
      // copia que se quedaria atras si Madrid+D remaqueta la pagina.
      expect(store.config.containerSelector).toBe(preset.containerSelector);
      expect(store.config.itemSelector).toBeNull();
      expect(store.config.insertPosition).toBe('PREPEND');
    });

    it('6.2 deberia dejar el paso ya valido tras cargar ABRIR_LICITACION', () => {
      // 1. Arrange 📐: es el objetivo del boton, ahorrar el UUID tecleado.
      const store = buildStore();

      // 2. Act ⚙️
      store.applyAbrirLicitacionPreset();

      // 3. Assert 🎯
      expect(store.isConfigValid).toBe(true);
    });

    it('6.3 deberia cargar CERRAR_LICITACION con su selector de bloque', () => {
      // 1. Arrange 📐
      const store = buildStore();

      // 2. Act ⚙️
      store.applyCerrarLicitacionPreset();

      // 3. Assert 🎯: `.licitacion-entry` es la clase del envoltorio que siembra
      //    la plantilla de apertura; sin ella el traslado no encuentra que mover.
      expect(store.config.operationMode).toBe(DrupalOperationMode.TRANSFER_HTML_BLOCK);
      expect(store.config.itemSelector).toBe('.pd-licitacion-block, .licitacion-entry');
      // Dentro del cuerpo del acordeon de cerradas, y arriba: lo ultimo cerrado
      // se lee primero, como en la pagina de abiertas.
      expect(store.config.targetContainerSelector).toBe('#collapse2 > .panel-body');
      expect(store.config.insertPosition).toBe('PREPEND');
    });

    it('6.4 deberia dejar CERRAR_LICITACION INVALIDO por falta de destino', () => {
      // 1. Arrange 📐: es la prueba mas importante de este bloque. El destino se
      //    deja nulo A PROPOSITO —la pagina de cerradas no tiene UUID conocido—
      //    y apuntarlo a la de abiertas seria destructivo: `runTransferHtmlBlock`
      //    lee origen y destino por separado, y el segundo PATCH pisa al primero
      //    con un DOM ya obsoleto, borrando el bloque sin dejar copia. Que el
      //    paso quede invalido es lo que obliga a escribir el destino de verdad.
      const store = buildStore();

      // 2. Act ⚙️
      store.applyCerrarLicitacionPreset();

      // 3. Assert 🎯
      expect(store.config.destinationNodeUuid).toBeNull();
      expect(store.missingRequiredParams).toContain('destinationNodeUuid');
      expect(store.isConfigValid).toBe(false);
    });

    it('6.5 deberia cargar VERIFICACION_TITULOS con su bundle y modo propios', () => {
      // 1. Arrange 📐
      const store = buildStore();

      // 2. Act ⚙️
      store.applyVerificacionTitulosPreset();

      // 3. Assert 🎯: APPEND_HTML_BLOCK y ya no CREATE_NODE. Lo que el portal
      //    presenta es un ACORDEON: cada comite es un panel colapsable dentro
      //    del HTML de la pagina agregadora, no un nodo suelto que nadie
      //    alcanzaria desde la pagina que lo agrega.
      expect(store.config.operationMode).toBe(DrupalOperationMode.APPEND_HTML_BLOCK);
      expect(store.config.bundle).toBe('node--page');
      expect(store.config.targetNodeUuid).toBe(SANDBOX_TITULOS_UUID);
      // El contenedor es el acordeon RAIZ y actua de respaldo: el destino real
      // lo decide cada panel por su `data-parent`. Apuntarlo a la universidad
      // CEU mandaria alli los paneles sin destino resoluble.
      expect(store.config.containerSelector).toBe('#accordion');
      expect(store.config.itemSelector).toBe('.panel-default');
      // "Al final" en el QSelect. A diferencia del resto de canales, el destino
      // no es una lista cronologica sino el sub-acordeon de una universidad:
      // encabezarlo con el ultimo comite reordenaria paneles ya publicados.
      expect(store.config.insertPosition).toBe('APPEND');
    });

    it('6.5bis deberia EMITIR insertPosition en los params al diferir del defecto', () => {
      // 1. Arrange 📐: `buildParams` omite lo que coincide con el defecto del
      //    backend, que es PREPEND. Mientras el preset valia PREPEND la clave
      //    NO viajaba en el pipeline_schema; ahora debe viajar, porque es lo
      //    unico que hace que el motor llame a `.append()`.
      const store = buildStore();

      // 2. Act ⚙️
      store.applyVerificacionTitulosPreset();

      // 3. Assert 🎯
      expect(store.toNodeParams()).toMatchObject({ insertPosition: 'APPEND' });
    });

    it('6.6 deberia LIMPIAR los campos que el preset nuevo no usa', () => {
      // 1. Arrange 📐: el operador prueba el traslado y despues se pasa a la
      //    apertura. Si el preset solo parcheara los campos que le aplican, el
      //    `itemSelector` del traslado quedaria colgado en una configuracion que
      //    ya no lo lee, y reapareceria al volver al otro modo.
      const store = buildStore();
      store.applyCerrarLicitacionPreset();
      expect(store.config.itemSelector).toBe('.pd-licitacion-block, .licitacion-entry');

      // 2. Act ⚙️
      store.applyAbrirLicitacionPreset();

      // 3. Assert 🎯
      expect(store.config.itemSelector).toBeNull();
      expect(store.config.insertPosition).toBe('PREPEND');
    });

    it('6.7 deberia exponer un applyPreset generico equivalente al atajo', () => {
      // 1. Arrange 📐: los atajos existen para que renombrar una clave sea un
      //    error de compilacion, pero el generico es el que recorre el catalogo
      //    desde la plantilla. Los dos caminos tienen que coincidir.
      const porAtajo = buildStore();
      const porClave = buildStore();

      // 2. Act ⚙️
      porAtajo.applyVerificacionTitulosPreset();
      porClave.applyPreset('VERIFICACION_TITULOS');

      // 3. Assert 🎯
      expect(porClave.config).toEqual(porAtajo.config);
    });
  });

  describe('7. Ensamblado de `params`', () => {
    it('7.1 deberia publicar SIEMPRE el modo, aunque sea el defecto', () => {
      // 1. Arrange 📐
      const store = buildStore();
      store.updateConfig({ titleTemplate: 'Titular' });

      // 2. Act ⚙️
      const params = store.toNodeParams();

      // 3. Assert 🎯: es el discriminador del que depende leer todo lo demas;
      //    dejarlo implicito esconde la decision mas importante del formulario.
      expect(params.operationMode).toBe(DrupalOperationMode.CREATE_NODE);
    });

    it('7.2 deberia omitir lo que coincide con el defecto del backend', () => {
      // 1. Arrange 📐
      const store = buildStore();

      // 2. Act ⚙️
      store.updateConfig({ titleTemplate: 'Titular' });
      const params = store.toNodeParams();

      // 3. Assert 🎯: un flujo recien creado no debe escribir veinte claves
      //    que nadie ha tocado; el motor repone el mismo valor. El entorno y el
      //    modo viajan siempre.
      expect(params).toEqual({
        isSandbox: true,
        operationMode: DrupalOperationMode.CREATE_NODE,
        // En Sandbox el borrador es obligatorio y viaja explicito.
        publishStatus: false,
        titleTemplate: 'Titular',
      });
    });

    it('7.3 deberia publicar publishStatus solo cuando es false', () => {
      // 1. Arrange 📐: `true` es el defecto y significa "no he dicho nada".
      //    Solo en Produccion: en Sandbox nunca se publica.
      const store = buildStore();
      store.setSandbox(false);
      store.updateConfig({ titleTemplate: 'Titular', publishStatus: true });

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(store.toNodeParams()).not.toHaveProperty('publishStatus');

      store.updateConfig({ publishStatus: false });
      expect(store.toNodeParams().publishStatus).toBe(false);
    });

    it('7.3bis deberia publicar uploadAttachment solo cuando se enciende', () => {
      // 1. Arrange 📐: simetrico a `publishStatus` y por un motivo mas
      //    fuerte: subir un fichero escribe en Drupal, y un efecto externo no
      //    puede quedar encendido por un defecto que nadie eligio.
      const store = buildStore();
      store.updateConfig({
        operationMode: DrupalOperationMode.APPEND_HTML_BLOCK,
        targetNodeUuid: SOURCE_UUID,
      });

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(store.toNodeParams()).not.toHaveProperty('uploadAttachment');

      store.updateConfig({ uploadAttachment: true });
      expect(store.toNodeParams().uploadAttachment).toBe(true);

      // El selector solo viaja si se aparta del que ya repone el backend.
      expect(store.toNodeParams()).not.toHaveProperty('attachmentListSelector');

      store.updateConfig({ attachmentListSelector: 'ul.otros-anexos' });
      expect(store.toNodeParams().attachmentListSelector).toBe('ul.otros-anexos');
    });

    it('7.4 NO deberia publicar ninguna clave ajena al DTO', () => {
      // 1. Arrange 📐: el DTO se valida con `forbidNonWhitelisted`, asi que una
      //    clave de mas no se ignora: devuelve un 400 al guardar el flujo.
      const store = buildStore();
      const allowed = new Set([
        'isSandbox',
        'operationMode',
        'linkSelector',
        'linkAttribute',
        'linkValueTemplate',
        'bundle',
        'sourceNamespace',
        'sourceField',
        'titleTemplate',
        'summaryTemplate',
        'bodyFieldName',
        'bodyFormat',
        'publishStatus',
        'targetNodeUuid',
        'destinationNodeUuid',
        'containerSelector',
        'itemSelector',
        'insertPosition',
        'attachmentNamespace',
        'attachmentField',
        'attachmentIndex',
        'fileFieldName',
      ]);

      // 2. Act ⚙️: una configuracion que toca TODOS los campos.
      store.updateConfig({
        operationMode: DrupalOperationMode.TRANSFER_HTML_BLOCK,
        bundle: 'node--page',
        sourceNamespace: 'llm_response',
        sourceField: 'filled_markup',
        titleTemplate: 'Titular',
        summaryTemplate: 'Resumen',
        bodyFieldName: 'field_cuerpo',
        bodyFormat: 'basic_html',
        publishStatus: false,
        targetNodeUuid: SOURCE_UUID,
        destinationNodeUuid: DESTINATION_UUID,
        containerSelector: '.listado',
        itemSelector: '.bloque',
        insertPosition: 'APPEND',
        attachmentNamespace: 'parsed_email',
        attachmentField: 'documentos',
        attachmentIndex: 3,
        fileFieldName: 'field_ficheros',
      });

      // 3. Assert 🎯
      Object.keys(store.toNodeParams()).forEach((key) => {
        expect(allowed.has(key)).toBe(true);
      });
    });

    it('7.5 deberia conservar lo configurado aunque el modo activo no lo use', () => {
      // 1. Arrange 📐: el DTO declara los dieciocho, asi que publicarlos no es
      //    un `forbidNonWhitelisted`; borrarlos perderia el trabajo del
      //    operador que vuelve al modo anterior.
      const store = buildStore();

      // 2. Act ⚙️
      store.updateConfig({
        operationMode: DrupalOperationMode.CREATE_NODE,
        titleTemplate: 'Titular',
        itemSelector: '.bloque',
      });

      // 3. Assert 🎯
      expect(store.toNodeParams().itemSelector).toBe('.bloque');
    });
  });

  describe('8. Hidratacion de un flujo guardado', () => {
    it('8.1 deberia reproducir los params en el viaje de ida y vuelta', () => {
      // 1. Arrange 📐: la invariante del contrato `NodeConfigStore`.
      const store = buildStore();
      const params: Record<string, unknown> = {
        isSandbox: false,
        operationMode: DrupalOperationMode.TRANSFER_HTML_BLOCK,
        bundle: 'node--page',
        targetNodeUuid: SOURCE_UUID,
        destinationNodeUuid: DESTINATION_UUID,
        itemSelector: '[data-expediente="S_2026_015"]',
        insertPosition: 'APPEND',
        attachmentIndex: 2,
        publishStatus: false,
      };

      // 2. Act ⚙️
      store.hydrateFromNode({ outputNamespace: 'http_result', params });

      // 3. Assert 🎯
      expect(store.toNodeParams()).toEqual(params);
    });

    it('8.2 deberia caer al defecto ante un tipo inesperado en el jsonb', () => {
      // 1. Arrange 📐: la columna pudo escribirse por SQL directo, y un
      //    `undefined` enlazado a un control de Quasar lo deja descontrolado.
      const store = buildStore();

      // 2. Act ⚙️
      store.hydrateFromNode({
        outputNamespace: 'http_result',
        params: {
          operationMode: 'MODO_INVENTADO',
          attachmentIndex: '3',
          publishStatus: 'si',
          insertPosition: 'MEDIO',
          bundle: 42,
        },
      });

      // 3. Assert 🎯
      expect(store.config.operationMode).toBe(DrupalOperationMode.CREATE_NODE);
      expect(store.config.attachmentIndex).toBe(0);
      // El defecto del jsonb es publicar, pero sin `isSandbox` el nodo se
      // hidrata en Sandbox, y alli es siempre borrador.
      expect(store.config.publishStatus).toBe(false);
      expect(store.config.insertPosition).toBe('PREPEND');
      expect(store.config.bundle).toBe(DEFAULT_DRUPAL_BUNDLE);
    });

    it('8.3 deberia tratar una cadena en blanco como ausencia', () => {
      // 1. Arrange 📐: el backend resuelve con `trimmedOrNull`, asi que un
      //    `"  "` no cuenta como valor declarado. Mostrarlo como configurado
      //    dejaria el paso en verde con un titulo que el motor vera vacio.
      const store = buildStore();

      // 2. Act ⚙️
      store.hydrateFromNode({
        outputNamespace: 'http_result',
        params: { titleTemplate: '   ' },
      });

      // 3. Assert 🎯
      expect(store.config.titleTemplate).toBeNull();
      expect(store.isConfigValid).toBe(false);
    });

    it('8.4 deberia aceptar los params vacios de una plantilla de flujo', () => {
      // 1. Arrange 📐: una plantilla es topologia sin operativa.
      const store = buildStore();

      // 2. Act ⚙️
      store.hydrateFromNode({ outputNamespace: 'http_result', params: {} });

      // 3. Assert 🎯: se hidrata sin romper, pero el paso sigue sin titulo.
      expect(store.config.operationMode).toBe(DrupalOperationMode.CREATE_NODE);
      expect(store.isConfigValid).toBe(false);
    });
  });

  describe('9. Reinicio', () => {
    it('9.1 deberia devolver config y contexto a su estado inicial', () => {
      // 1. Arrange 📐: la instancia del store sobrevive a la topologia que la
      //    creo, asi que sin esto un flujo nuevo arrancaria con el anterior.
      const store = buildStore();
      store.updateConfig({ titleTemplate: 'Titular', bundle: 'node--page' });
      store.setAvailableUpstreamContext(FULL_UPSTREAM);

      // 2. Act ⚙️
      store.resetConfig();

      // 3. Assert 🎯
      expect(store.config.titleTemplate).toBeNull();
      expect(store.config.bundle).toBe(DEFAULT_DRUPAL_BUNDLE);
      expect(store.namespaceOptions).toEqual([]);
    });
  });

  describe('7. Preset de Notiweb', () => {
    it('7.1 deberia dar de alta contenido nuevo sin pagina receptora', () => {
      // 1. Arrange 📐
      const store = buildStore();

      // 2. Act ⚙️
      store.applyNotiwebPreset();

      // 3. Assert 🎯: modo, bundle y ausencia de contenedor se escriben a la
      //    vez; por separado no significan nada.
      expect(store.config.operationMode).toBe(DrupalOperationMode.CREATE_NODE);
      expect(store.config.bundle).toBe('node--noticias');
      expect(store.config.containerSelector).toBeNull();
      expect(store.config.itemSelector).toBeNull();
    });

    it('7.2 deberia dejar el UUID sin rellenar en vez de inventar uno', () => {
      // 1. Arrange 📐
      const store = buildStore();

      // 2. Act ⚙️
      store.applyNotiwebPreset();

      // 3. Assert 🎯: cada noticia es su propia entidad y no cuelga de ninguna
      //    pagina conocida. Un UUID v4 inventado casaria el patron, dejaria el
      //    paso valido y reventaria en ejecucion con un 404 ya PAUSADO.
      expect(store.config.targetNodeUuid).toBeNull();
    });
  });

  describe('10. Entorno Sandbox / Produccion', () => {
    it('10.1 deberia arrancar en Sandbox y publicarlo siempre en los params', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const store = buildStore();

      // 3. Assert 🎯: el entorno se lee en el esquema, no se deduce.
      expect(store.config.isSandbox).toBe(true);
      expect(store.toNodeParams()).toMatchObject({ isSandbox: true });
    });

    it('10.2 deberia mover las paginas del preset al cambiar de entorno', () => {
      // 1. Arrange 📐
      const store = buildStore();
      store.applyAbrirLicitacionPreset();

      // 2. Act ⚙️
      store.setSandbox(false);

      // 3. Assert 🎯: en Produccion el UUID no esta confirmado y queda vacio,
      //    de modo que el paso exige escribirlo antes de guardar.
      expect(store.config.isSandbox).toBe(false);
      expect(store.config.targetNodeUuid).toBeNull();
      expect(store.isConfigValid).toBe(false);

      // 2. Act ⚙️ (vuelta)
      store.setSandbox(true);

      // 3. Assert 🎯
      expect(store.config.targetNodeUuid).toBe(SANDBOX_LICITACIONES_UUID);
    });

    it('10.3 NO deberia pisar un UUID tecleado a mano al cambiar de entorno', () => {
      // 1. Arrange 📐: el operador escribio la pagina de produccion.
      const store = buildStore();
      store.setSandbox(false);
      store.applyAbrirLicitacionPreset();
      const typed = '11111111-2222-4333-8444-555555555555';
      store.updateConfig({ targetNodeUuid: typed });

      // 2. Act ⚙️
      store.setSandbox(true);

      // 3. Assert 🎯
      expect(store.config.targetNodeUuid).toBe(typed);
    });

    it('10.4 deberia cargar Innodays como actualizacion de enlace con la pagina pendiente', () => {
      // 1. Arrange 📐
      const store = buildStore();

      // 2. Act ⚙️
      store.applyInnodaysPreset();

      // 3. Assert 🎯: modo, bundle, atributo, fila del evento y enlace listos
      //    (prompts de la migracion 063); la pagina la pone el backend, y aqui
      //    no esta declarada.
      expect(store.config.operationMode).toBe(DrupalOperationMode.UPDATE_LINK_SOURCE);
      expect(store.config.bundle).toBe('node--page');
      expect(store.config.linkAttribute).toBe('href');
      expect(store.missingRequiredParams).toEqual(['targetNodeUuid']);
    });

    it('10.5 deberia emitir y recuperar los params del modo enlace', () => {
      // 1. Arrange 📐
      const store = buildStore();
      store.applyInnodaysPreset();
      store.updateConfig({
        targetNodeUuid: '3c2b1a0f-9e8d-4c7b-8a69-5f4e3d2c1b0a',
        linkSelector: '#carousel-track img:first-child',
        linkAttribute: 'src',
        linkValueTemplate: '{{llm_response.url}}',
      });

      // 2. Act ⚙️
      const params = store.toNodeParams();
      const other = buildStore();
      other.hydrateFromNode({ outputNamespace: 'http_result', params });

      // 3. Assert 🎯
      expect(params).toMatchObject({
        isSandbox: true,
        operationMode: DrupalOperationMode.UPDATE_LINK_SOURCE,
        linkSelector: '#carousel-track img:first-child',
        linkAttribute: 'src',
        linkValueTemplate: '{{llm_response.url}}',
      });
      expect(other.config).toMatchObject({
        isSandbox: true,
        linkAttribute: 'src',
        linkValueTemplate: '{{llm_response.url}}',
      });
      expect(other.isConfigValid).toBe(true);
    });

    it('10.6 deberia dejar Notiweb como borrador despublicado', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const store = buildStore();
      store.applyNotiwebPreset();

      // 3. Assert 🎯
      expect(store.config.publishStatus).toBe(false);
      expect(store.toNodeParams()).toMatchObject({ publishStatus: false });
    });
  });

  describe('11. Innobar, expediente y borrador en Sandbox', () => {
    it('11.1 deberia ignorar publishStatus true mientras el nodo este en Sandbox', () => {
      // 1. Arrange 📐
      const store = buildStore();

      // 2. Act ⚙️
      store.updateConfig({ publishStatus: true });

      // 3. Assert 🎯
      expect(store.config.publishStatus).toBe(false);
    });

    it('11.2 deberia forzar borrador al volver a Sandbox', () => {
      // 1. Arrange 📐
      const store = buildStore();
      store.setSandbox(false);
      store.updateConfig({ publishStatus: true });

      // 2. Act ⚙️
      store.setSandbox(true);

      // 3. Assert 🎯
      expect(store.config.publishStatus).toBe(false);
    });

    it('11.3 deberia publicar e hidratar expedienteTemplate', () => {
      // 1. Arrange 📐
      const store = buildStore();
      store.applyAbrirLicitacionPreset();
      store.updateConfig({ expedienteTemplate: '{{llm_response.headline}}' });

      // 2. Act ⚙️
      const params = store.toNodeParams();
      const other = buildStore();
      other.hydrateFromNode({ outputNamespace: 'http_result', params });

      // 3. Assert 🎯
      expect(params.expedienteTemplate).toBe('{{llm_response.headline}}');
      expect(other.config.expedienteTemplate).toBe('{{llm_response.headline}}');
    });

    it('11.4 deberia cargar Innobar como actualizacion de enlace', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const store = buildStore();
      store.applyInnobarPreset();

      // 3. Assert 🎯
      expect(store.config.operationMode).toBe(DrupalOperationMode.UPDATE_LINK_SOURCE);
      expect(store.config.linkAttribute).toBe('href');
    });
  });

  describe('12. Contenedor de destino y campos de Notiweb', () => {
    it('12.1 deberia prefijar seccion y tipo de Notiweb y limpiarlos al cambiar de preset', () => {
      // 1. Arrange 📐
      const store = buildStore();

      // 2. Act ⚙️
      store.applyNotiwebPreset();
      const notiweb = { ...store.config };
      store.applyAbrirLicitacionPreset();

      // 3. Assert 🎯: seccion «Notiweb» y tipo «Noticias»; la fuente depende de
      //    cada noticia y queda a cargo del operador.
      expect(notiweb.newsSectionTermUuid).toBe('d4964d27-7819-4975-81ca-c0554ee7b233');
      expect(notiweb.newsTypeTermUuid).toBe('6c18cd7a-a5cd-4332-8271-6bdee4ef9834');
      expect(notiweb.newsSourceTermUuid).toBeNull();
      expect(store.config.newsSectionTermUuid).toBeNull();
      expect(store.config.newsTypeTermUuid).toBeNull();
    });

    it('12.2 deberia publicar los campos nuevos en los params y recuperarlos al hidratar', () => {
      // 1. Arrange 📐
      const store = buildStore();
      store.applyNotiwebPreset();
      store.updateConfig({
        authorTemplate: '{{parsed_email.from}}',
        dateTemplate: '{{parsed_email.date}}',
        orderValue: 3,
      });

      // 2. Act ⚙️
      const params = store.toNodeParams();
      const copy = buildStore();
      copy.hydrateFromNode({ outputNamespace: 'drupal_result', params });

      // 3. Assert 🎯: ida y vuelta sin perdidas.
      expect(params).toMatchObject({
        authorTemplate: '{{parsed_email.from}}',
        dateTemplate: '{{parsed_email.date}}',
        orderValue: 3,
        newsSectionTermUuid: 'd4964d27-7819-4975-81ca-c0554ee7b233',
        newsTypeTermUuid: '6c18cd7a-a5cd-4332-8271-6bdee4ef9834',
      });
      expect(params).not.toHaveProperty('newsSourceTermUuid');
      expect(copy.toNodeParams()).toEqual(params);
    });

    it('12.3 NO deberia publicar el orden cuando es el de por defecto', () => {
      const store = buildStore();

      store.applyNotiwebPreset();

      expect(store.toNodeParams()).not.toHaveProperty('orderValue');
    });

    it('12.4 deberia publicar el contenedor de destino del traslado', () => {
      const store = buildStore();

      store.applyCerrarLicitacionPreset();

      const params = store.toNodeParams();

      // `PREPEND` es el defecto del backend, asi que no viaja.
      expect(params).toMatchObject({ targetContainerSelector: '#collapse2 > .panel-body' });
      expect(params).not.toHaveProperty('insertPosition');
    });

    it('12.5 deberia invalidar un UUID de taxonomia mal formado y un orden fuera de rango', () => {
      // 1. Arrange 📐
      const store = buildStore();
      store.applyNotiwebPreset();

      // 2. Act ⚙️
      store.updateConfig({ newsSourceTermUuid: 'no-es-un-uuid', orderValue: 10_000 });

      // 3. Assert 🎯
      expect(store.malformedParams).toEqual(
        expect.arrayContaining(['newsSourceTermUuid', 'orderValue']),
      );
      expect(store.isConfigValid).toBe(false);
    });
  });

  describe('13. Paginas servidas por el backend', () => {
    it('13.1 deberia cargar las paginas una sola vez y aplicarlas al preset', async () => {
      // 1. Arrange 📐
      const { fetchDrupalPresetTargets } = await import('@services/nodes/drupal-http.service');
      vi.mocked(fetchDrupalPresetTargets).mockResolvedValue(DRUPAL_PRESET_TARGETS_FIXTURE);
      vi.mocked(fetchDrupalPresetTargets).mockClear();
      const store = useDrupalHttpStore(nextNodeId());

      // 2. Act ⚙️
      await store.loadPresetTargets();
      await store.loadPresetTargets();
      store.applyVerificacionTitulosPreset();

      // 3. Assert 🎯
      expect(fetchDrupalPresetTargets).toHaveBeenCalledTimes(1);
      expect(store.config.targetNodeUuid).toBe(SANDBOX_TITULOS_UUID);
      expect(store.isLoadingPresetTargets).toBe(false);
    });

    it('13.2 deberia dejar la pagina para el operador si la carga falla', async () => {
      // 1. Arrange 📐
      const { fetchDrupalPresetTargets } = await import('@services/nodes/drupal-http.service');
      vi.mocked(fetchDrupalPresetTargets).mockRejectedValue(new Error('503'));
      const store = useDrupalHttpStore(nextNodeId());

      // 2. Act ⚙️: el error se propaga, el componente decide el aviso.
      await expect(store.loadPresetTargets()).rejects.toThrow('503');
      store.applyAbrirLicitacionPreset();

      // 3. Assert 🎯
      expect(store.isLoadingPresetTargets).toBe(false);
      expect(store.config.targetNodeUuid).toBeNull();
      expect(store.missingRequiredParams).toContain('targetNodeUuid');
    });

    it('13.3 deberia proponer las plantillas de Notiweb sin pisar las ya escritas', () => {
      // 1. Arrange 📐
      const store = buildStore();
      store.updateConfig({ titleTemplate: 'Titular a mano' });

      // 2. Act ⚙️
      store.applyNotiwebPreset();

      // 3. Assert 🎯
      expect(store.config).toMatchObject({
        titleTemplate: 'Titular a mano',
        summaryTemplate: '{{llm_response.summary}}',
        authorTemplate: '{{raw_email.from_name}}',
        authorFallback: 'Madrid+D',
        dateTemplate: '{{raw_email.date}}',
      });
    });

    it('13.4 deberia cargar Innodays con la fila del evento y el enlace del PROCESADOR_IA', () => {
      const store = buildStore();

      store.applyInnodaysPreset();

      expect(store.config.linkSelector).toBe("table tr:contains('{{llm_response.headline}}') a");
      expect(store.config.linkValueTemplate).toBe('{{llm_response.summary}}');
    });

    it('13.5 deberia publicar y recuperar el autor de respaldo', () => {
      // 1. Arrange 📐
      const store = buildStore();
      store.applyNotiwebPreset();

      // 2. Act ⚙️
      const params = store.toNodeParams();
      const copy = buildStore();
      copy.hydrateFromNode({ outputNamespace: 'drupal_result', params });

      // 3. Assert 🎯
      expect(params.authorFallback).toBe('Madrid+D');
      expect(copy.config.authorFallback).toBe('Madrid+D');
    });
  });

  describe('12. Origen del marcado: escudo primero, procesador IA de respaldo', () => {
    const SHIELD: UpstreamNamespace = {
      namespace: 'validated_drupal_json',
      nodeType: NodeType.ESCUDO_POST_IA,
      fields: [{ name: 'validated_markup', type: 'text' }],
    };
    const LLM: UpstreamNamespace = {
      namespace: 'llm_response',
      nodeType: NodeType.PROCESADOR_IA,
      fields: [{ name: 'filled_markup', type: 'text' }],
    };
    const TRIGGER: UpstreamNamespace = {
      namespace: 'raw_email',
      nodeType: NodeType.TRIGGER_IMAP,
      fields: [],
    };

    const buildCreateNodeStore = (): ReturnType<typeof useDrupalHttpStore> => {
      const store = buildStore();
      store.updateConfig({
        operationMode: DrupalOperationMode.CREATE_NODE,
        titleTemplate: 'Titular',
      });

      return store;
    };

    it('12.1 deberia preferir el escudo y no tocar el origen por defecto', () => {
      // 1. Arrange 📐
      const store = buildCreateNodeStore();

      // 2. Act ⚙️
      store.setAvailableUpstreamContext([TRIGGER, LLM, SHIELD]);

      // 3. Assert 🎯
      expect(store.config.sourceNamespace).toBe(DEFAULT_DRUPAL_SOURCE_NAMESPACE);
      expect(store.config.sourceField).toBe(DEFAULT_DRUPAL_SOURCE_FIELD);
      expect(store.sourceNamespaceBlockReason).toBeNull();
      expect(store.isConfigValid).toBe(true);
    });

    it('12.2 sin escudo deberia caer al procesador IA y avisar', () => {
      // 1. Arrange 📐
      const store = buildCreateNodeStore();

      // 2. Act ⚙️
      store.setAvailableUpstreamContext([TRIGGER, LLM]);

      // 3. Assert 🎯
      expect(store.config.sourceNamespace).toBe('llm_response');
      expect(store.config.sourceField).toBe('filled_markup');
      expect(store.sourceNamespaceBlockReason).toBeNull();
      expect(store.isConfigValid).toBe(true);
      expect(store.configWarnings.some((warning) => warning.includes('Escudo'))).toBe(true);
    });

    it('12.3 deberia bloquear el guardado sin escudo NI procesador IA', () => {
      // 1. Arrange 📐
      const store = buildCreateNodeStore();

      // 2. Act ⚙️
      store.setAvailableUpstreamContext([TRIGGER]);

      // 3. Assert 🎯
      expect(store.sourceNamespaceBlockReason).toContain('Escudo posterior a IA');
      expect(store.isConfigValid).toBe(false);
    });

    it('12.4 no deberia bloquear modos que no publican marcado ni con contexto vacio', () => {
      // 1. Arrange 📐
      const transfer = buildStore();
      transfer.updateConfig({ operationMode: DrupalOperationMode.TRANSFER_HTML_BLOCK });
      const notLoaded = buildCreateNodeStore();

      // 2. Act ⚙️
      transfer.setAvailableUpstreamContext([TRIGGER]);
      notLoaded.setAvailableUpstreamContext([]);

      // 3. Assert 🎯
      expect(transfer.sourceNamespaceBlockReason).toBeNull();
      expect(notLoaded.sourceNamespaceBlockReason).toBeNull();
    });

    it('12.5 no deberia reescribir un origen elegido a mano', () => {
      // 1. Arrange 📐
      const store = buildCreateNodeStore();
      store.updateConfig({ sourceNamespace: 'ocr_result', sourceField: 'clean_body' });

      // 2. Act ⚙️
      store.setAvailableUpstreamContext([TRIGGER, LLM]);

      // 3. Assert 🎯
      expect(store.config.sourceNamespace).toBe('ocr_result');
    });
  });
});
