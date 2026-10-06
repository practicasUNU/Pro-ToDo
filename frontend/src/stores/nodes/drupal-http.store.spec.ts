import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';

import { NodeType } from '@/types/pipeline';
import {
  DEFAULT_DRUPAL_ATTACHMENT_FIELD,
  DEFAULT_DRUPAL_ATTACHMENT_NAMESPACE,
  DEFAULT_DRUPAL_BODY_FIELD,
  DEFAULT_DRUPAL_BODY_FORMAT,
  DEFAULT_DRUPAL_BUNDLE,
  DEFAULT_DRUPAL_FILE_FIELD_NAME,
  DEFAULT_DRUPAL_SOURCE_FIELD,
  DEFAULT_DRUPAL_SOURCE_NAMESPACE,
  DRUPAL_SANDBOX_PRESETS,
  DrupalOperationMode,
  MAX_DRUPAL_ATTACHMENT_INDEX,
  MAX_DRUPAL_SELECTOR_LENGTH,
  MAX_DRUPAL_TITLE_LENGTH,
} from '@/types/nodes/drupal-http.types';

import { useDrupalHttpStore } from './drupal-http.store';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

/**
 * `nodeId` unico por prueba.
 *
 * Las definiciones de Pinia se memoizan en un `Map` de MODULO que sobrevive
 * entre pruebas, asi que reutilizar un id arrastraria el estado de la anterior.
 * `setActivePinia` reinicia las instancias, no el mapa de definiciones.
 */
let nodeCounter = 0;
const nextNodeId = (): string => `destino_http_${(nodeCounter += 1)}`;

/** UUID v4 validos, para no depender de literales repetidos por el archivo. */
const SOURCE_UUID = DRUPAL_SANDBOX_PRESETS.ABRIR_LICITACION.targetNodeUuid;
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
      const store = useDrupalHttpStore(nextNodeId());

      // 2. Act ⚙️ & 3. Assert 🎯: la replica tiene que coincidir campo a campo,
      //    o la interfaz mostraria una configuracion distinta de la que corre.
      expect(store.config).toEqual({
        operationMode: DrupalOperationMode.CREATE_NODE,
        bundle: DEFAULT_DRUPAL_BUNDLE,
        sourceNamespace: DEFAULT_DRUPAL_SOURCE_NAMESPACE,
        sourceField: DEFAULT_DRUPAL_SOURCE_FIELD,
        titleTemplate: null,
        summaryTemplate: null,
        bodyFieldName: DEFAULT_DRUPAL_BODY_FIELD,
        bodyFormat: DEFAULT_DRUPAL_BODY_FORMAT,
        publishStatus: true,
        targetNodeUuid: null,
        destinationNodeUuid: null,
        containerSelector: null,
        itemSelector: null,
        insertPosition: 'PREPEND',
        attachmentNamespace: DEFAULT_DRUPAL_ATTACHMENT_NAMESPACE,
        attachmentField: DEFAULT_DRUPAL_ATTACHMENT_FIELD,
        attachmentIndex: 0,
        fileFieldName: DEFAULT_DRUPAL_FILE_FIELD_NAME,
      });
    });

    it('1.2 NO deberia nacer valido: el modo por defecto exige un titulo', () => {
      // 1. Arrange 📐
      const store = useDrupalHttpStore(nextNodeId());

      // 2. Act ⚙️ & 3. Assert 🎯: a diferencia del escudo, cuyo DTO admite
      //    `params: {}` ejecutables, este nodo no puede publicar sin titulo.
      expect(store.isConfigValid).toBe(false);
      expect(store.missingRequiredParams).toEqual(['titleTemplate']);
    });

    it('1.3 deberia aislar la configuracion entre dos nodos del mismo tipo', () => {
      // 1. Arrange 📐: un flujo puede crear la noticia Y cerrar su licitacion.
      const first = useDrupalHttpStore(nextNodeId());
      const second = useDrupalHttpStore(nextNodeId());

      // 2. Act ⚙️
      first.updateConfig({ bundle: 'node--page' });

      // 3. Assert 🎯
      expect(second.config.bundle).toBe(DEFAULT_DRUPAL_BUNDLE);
    });
  });

  describe('2. Validez por modo de operacion', () => {
    it('2.1 CREATE_NODE deberia ser valido con solo el titulo', () => {
      // 1. Arrange 📐
      const store = useDrupalHttpStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ titleTemplate: '{{validated_drupal_json.headline}}' });

      // 3. Assert 🎯: `bundle` NO se exige aparte porque su defecto no es vacio;
      //    pedirlo seria una condicion que no puede fallar nunca.
      expect(store.isConfigValid).toBe(true);
    });

    it('2.2 APPEND_HTML_BLOCK deberia exigir el identificador de la pagina', () => {
      // 1. Arrange 📐
      const store = useDrupalHttpStore(nextNodeId());

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
      const store = useDrupalHttpStore(nextNodeId());

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
      const store = useDrupalHttpStore(nextNodeId());

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
      const store = useDrupalHttpStore(nextNodeId());
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
      const store = useDrupalHttpStore(nextNodeId());
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
      const store = useDrupalHttpStore(nextNodeId());

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
      const store = useDrupalHttpStore(nextNodeId());

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
      const store = useDrupalHttpStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ titleTemplate: 'x'.repeat(MAX_DRUPAL_TITLE_LENGTH + 1) });

      // 3. Assert 🎯
      expect(store.malformedParams).toContain('titleTemplate');
      expect(store.isConfigValid).toBe(false);
    });

    it('3.5 deberia invalidar un selector mas largo que el tope del DTO', () => {
      // 1. Arrange 📐
      const store = useDrupalHttpStore(nextNodeId());

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
      const store = useDrupalHttpStore(nextNodeId());
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
      const store = useDrupalHttpStore(nextNodeId());
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
      const store = useDrupalHttpStore(nextNodeId());

      // 2. Act ⚙️
      store.setAvailableUpstreamContext(FULL_UPSTREAM);

      // 3. Assert 🎯
      expect(store.namespaceOptions).toEqual(['raw_email', 'validated_drupal_json']);
    });

    it('4.2 deberia ofrecer los campos del namespace de origen elegido', () => {
      // 1. Arrange 📐: el defecto ya apunta a `validated_drupal_json`.
      const store = useDrupalHttpStore(nextNodeId());

      // 2. Act ⚙️
      store.setAvailableUpstreamContext(FULL_UPSTREAM);

      // 3. Assert 🎯
      expect(store.fieldOptions).toEqual(['validated_markup', 'audit_status']);
    });

    it('4.3 deberia separar los campos del adjunto de los del markup', () => {
      // 1. Arrange 📐: son dos namespaces distintos y cada selector es suyo.
      const store = useDrupalHttpStore(nextNodeId());

      // 2. Act ⚙️
      store.setAvailableUpstreamContext(FULL_UPSTREAM);

      // 3. Assert 🎯
      expect(store.attachmentFieldOptions).toEqual(['attachments']);
    });

    it('4.4 deberia copiar el contexto y no guardar la referencia del anfitrion', () => {
      // 1. Arrange 📐
      const store = useDrupalHttpStore(nextNodeId());
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
      // 1. Arrange 📐: un flujo sin escudo delante.
      const store = useDrupalHttpStore(nextNodeId());
      store.updateConfig({ titleTemplate: 'Titular' });

      // 2. Act ⚙️
      store.setAvailableUpstreamContext([
        { namespace: 'raw_email', nodeType: NodeType.TRIGGER_IMAP, fields: [] },
      ]);

      // 3. Assert 🎯: avisa y NO bloquea; el 400 de la regla 7 no nombra el
      //    campo del formulario y este mensaje si nombra el namespace.
      expect(store.configWarnings).toHaveLength(1);
      expect(store.configWarnings[0]).toContain(DEFAULT_DRUPAL_SOURCE_NAMESPACE);
      expect(store.isConfigValid).toBe(true);
    });

    it('5.2 NO deberia avisar mientras el contexto esta vacio', () => {
      // 1. Arrange 📐: el catalogo de nodos todavia no ha cargado.
      const store = useDrupalHttpStore(nextNodeId());

      // 2. Act ⚙️ & 3. Assert 🎯: con el contexto vacio no se puede afirmar
      //    nada, y avisar seria una falsa alarma en cada apertura.
      expect(store.configWarnings).toEqual([]);
    });

    it('5.3 NO deberia avisar del origen en TRANSFER_HTML_BLOCK', () => {
      // 1. Arrange 📐: ese modo no lee el contexto, saca el bloque del DOM.
      const store = useDrupalHttpStore(nextNodeId());

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
      const store = useDrupalHttpStore(nextNodeId());

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
  });

  describe('6. Presets de destinos operativos', () => {
    it('6.1 deberia cargar los siete campos de ABRIR_LICITACION a la vez', () => {
      // 1. Arrange 📐: juntos o no significan nada. El UUID de la agregadora
      //    solo tiene sentido con `node--page` y un modo que mute HTML.
      const store = useDrupalHttpStore(nextNodeId());
      const preset = DRUPAL_SANDBOX_PRESETS.ABRIR_LICITACION;

      // 2. Act ⚙️
      store.applyAbrirLicitacionPreset();

      // 3. Assert 🎯
      expect(store.config.operationMode).toBe(DrupalOperationMode.APPEND_HTML_BLOCK);
      expect(store.config.bundle).toBe('node--page');
      expect(store.config.targetNodeUuid).toBe(preset.targetNodeUuid);
      expect(store.config.destinationNodeUuid).toBeNull();
      expect(store.config.containerSelector).toBeNull();
      expect(store.config.itemSelector).toBeNull();
      expect(store.config.insertPosition).toBe('PREPEND');
    });

    it('6.2 deberia dejar el paso ya valido tras cargar ABRIR_LICITACION', () => {
      // 1. Arrange 📐: es el objetivo del boton, ahorrar el UUID tecleado.
      const store = useDrupalHttpStore(nextNodeId());

      // 2. Act ⚙️
      store.applyAbrirLicitacionPreset();

      // 3. Assert 🎯
      expect(store.isConfigValid).toBe(true);
    });

    it('6.3 deberia cargar CERRAR_LICITACION con su selector de bloque', () => {
      // 1. Arrange 📐
      const store = useDrupalHttpStore(nextNodeId());

      // 2. Act ⚙️
      store.applyCerrarLicitacionPreset();

      // 3. Assert 🎯: `.licitacion-entry` es la clase del envoltorio que siembra
      //    la plantilla de apertura; sin ella el traslado no encuentra que mover.
      expect(store.config.operationMode).toBe(DrupalOperationMode.TRANSFER_HTML_BLOCK);
      expect(store.config.itemSelector).toBe('.licitacion-entry');
      expect(store.config.insertPosition).toBe('APPEND');
    });

    it('6.4 deberia dejar CERRAR_LICITACION INVALIDO por falta de destino', () => {
      // 1. Arrange 📐: es la prueba mas importante de este bloque. El destino se
      //    deja nulo A PROPOSITO —la pagina de cerradas no tiene UUID conocido—
      //    y apuntarlo a la de abiertas seria destructivo: `runTransferHtmlBlock`
      //    lee origen y destino por separado, y el segundo PATCH pisa al primero
      //    con un DOM ya obsoleto, borrando el bloque sin dejar copia. Que el
      //    paso quede invalido es lo que obliga a escribir el destino de verdad.
      const store = useDrupalHttpStore(nextNodeId());

      // 2. Act ⚙️
      store.applyCerrarLicitacionPreset();

      // 3. Assert 🎯
      expect(store.config.destinationNodeUuid).toBeNull();
      expect(store.missingRequiredParams).toContain('destinationNodeUuid');
      expect(store.isConfigValid).toBe(false);
    });

    it('6.5 deberia cargar VERIFICACION_TITULOS con su bundle y modo propios', () => {
      // 1. Arrange 📐
      const store = useDrupalHttpStore(nextNodeId());
      const preset = DRUPAL_SANDBOX_PRESETS.VERIFICACION_TITULOS;

      // 2. Act ⚙️
      store.applyVerificacionTitulosPreset();

      // 3. Assert 🎯: CREATE_NODE y no APPEND. Este canal da de alta una entidad
      //    por panel; no acumula bloques dentro de una pagina agregadora.
      expect(store.config.operationMode).toBe(DrupalOperationMode.CREATE_NODE);
      expect(store.config.bundle).toBe('node--acreditacion_evaluacion_panel');
      expect(store.config.targetNodeUuid).toBe(preset.targetNodeUuid);
    });

    it('6.6 deberia LIMPIAR los campos que el preset nuevo no usa', () => {
      // 1. Arrange 📐: el operador prueba el traslado y despues se pasa a la
      //    apertura. Si el preset solo parcheara los campos que le aplican, el
      //    `itemSelector` del traslado quedaria colgado en una configuracion que
      //    ya no lo lee, y reapareceria al volver al otro modo.
      const store = useDrupalHttpStore(nextNodeId());
      store.applyCerrarLicitacionPreset();
      expect(store.config.itemSelector).toBe('.licitacion-entry');

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
      const porAtajo = useDrupalHttpStore(nextNodeId());
      const porClave = useDrupalHttpStore(nextNodeId());

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
      const store = useDrupalHttpStore(nextNodeId());
      store.updateConfig({ titleTemplate: 'Titular' });

      // 2. Act ⚙️
      const params = store.toNodeParams();

      // 3. Assert 🎯: es el discriminador del que depende leer todo lo demas;
      //    dejarlo implicito esconde la decision mas importante del formulario.
      expect(params.operationMode).toBe(DrupalOperationMode.CREATE_NODE);
    });

    it('7.2 deberia omitir lo que coincide con el defecto del backend', () => {
      // 1. Arrange 📐
      const store = useDrupalHttpStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ titleTemplate: 'Titular' });
      const params = store.toNodeParams();

      // 3. Assert 🎯: un flujo recien creado no debe escribir dieciocho claves
      //    que nadie ha tocado; el motor repone el mismo valor.
      expect(params).toEqual({
        operationMode: DrupalOperationMode.CREATE_NODE,
        titleTemplate: 'Titular',
      });
    });

    it('7.3 deberia publicar publishStatus solo cuando es false', () => {
      // 1. Arrange 📐: `true` es el defecto y significa "no he dicho nada".
      const store = useDrupalHttpStore(nextNodeId());
      store.updateConfig({ titleTemplate: 'Titular' });

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(store.toNodeParams()).not.toHaveProperty('publishStatus');

      store.updateConfig({ publishStatus: false });
      expect(store.toNodeParams().publishStatus).toBe(false);
    });

    it('7.4 NO deberia publicar ninguna clave ajena al DTO', () => {
      // 1. Arrange 📐: el DTO se valida con `forbidNonWhitelisted`, asi que una
      //    clave de mas no se ignora: devuelve un 400 al guardar el flujo.
      const store = useDrupalHttpStore(nextNodeId());
      const allowed = new Set([
        'operationMode',
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
      const store = useDrupalHttpStore(nextNodeId());

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
      const store = useDrupalHttpStore(nextNodeId());
      const params: Record<string, unknown> = {
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
      const store = useDrupalHttpStore(nextNodeId());

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
      expect(store.config.publishStatus).toBe(true);
      expect(store.config.insertPosition).toBe('PREPEND');
      expect(store.config.bundle).toBe(DEFAULT_DRUPAL_BUNDLE);
    });

    it('8.3 deberia tratar una cadena en blanco como ausencia', () => {
      // 1. Arrange 📐: el backend resuelve con `trimmedOrNull`, asi que un
      //    `"  "` no cuenta como valor declarado. Mostrarlo como configurado
      //    dejaria el paso en verde con un titulo que el motor vera vacio.
      const store = useDrupalHttpStore(nextNodeId());

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
      const store = useDrupalHttpStore(nextNodeId());

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
      const store = useDrupalHttpStore(nextNodeId());
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
});
