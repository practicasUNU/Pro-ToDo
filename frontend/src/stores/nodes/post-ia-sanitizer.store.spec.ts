// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO, como en `llm-extractor.store.spec.ts`: las ranuras
// sugeridas se derivan parseando el HTML de la plantilla base con `DOMParser`,
// que no existe en el entorno `node` por defecto de vitest.
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';

import { NodeType } from '@/types/pipeline';
import {
  DEFAULT_POST_IA_SOURCE_FIELD,
  DEFAULT_POST_IA_SOURCE_NAMESPACE,
  MAX_REQUIRED_SELECTORS,
  MAX_SELECTOR_LENGTH,
  PostIaContentMode,
} from '@/types/nodes/post-ia-sanitizer.types';

import { usePostIaSanitizerStore } from './post-ia-sanitizer.store';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

/**
 * `nodeId` unico por prueba.
 *
 * Las definiciones de Pinia se memoizan en un `Map` de MODULO que sobrevive
 * entre pruebas, asi que reutilizar un id arrastraria el estado de la anterior.
 * `setActivePinia` reinicia las instancias, no el mapa de definiciones.
 */
let nodeCounter = 0;
const nextNodeId = (): string => `escudo_post_ia_${(nodeCounter += 1)}`;

/** Contexto tipico: un mapeador y un procesador de IA por delante. */
const FULL_UPSTREAM: UpstreamNamespace[] = [
  {
    namespace: 'rendered_html',
    nodeType: NodeType.MAPEADOR_PLANTILLA,
    fields: [
      { name: 'compiled_markup', type: 'text' },
      { name: 'mapped_at', type: 'text' },
    ],
  },
  {
    namespace: 'llm_response',
    nodeType: NodeType.PROCESADOR_IA,
    fields: [
      { name: 'headline', type: 'text' },
      { name: 'summary', type: 'text' },
      { name: 'filled_markup', type: 'text' },
      { name: 'metadata', type: 'object' },
    ],
  },
];

describe('usePostIaSanitizerStore · configuracion del nodo ESCUDO_POST_IA', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  describe('1. Estado inicial', () => {
    it('1.1 deberia apuntar al origen canonico del procesador de IA', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const store = usePostIaSanitizerStore(nextNodeId());

      // 3. Assert 🎯: son los mismos defectos que resuelve el backend, asi que
      //    un escudo sin tocar ya es un escudo que funciona.
      expect(store.config.sourceNamespace).toBe(DEFAULT_POST_IA_SOURCE_NAMESPACE);
      expect(store.config.sourceField).toBe(DEFAULT_POST_IA_SOURCE_FIELD);
      expect(store.config.requiredSelectors).toEqual([]);
      expect(store.config.allowedTags).toEqual([]);
    });

    it('1.2 deberia nacer valido', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const store = usePostIaSanitizerStore(nextNodeId());

      // 3. Assert 🎯: el DTO admite `params: {}` —una plantilla de flujo se
      //    guarda asi—, de modo que bloquear el asistente seria un Poka-Yoke al
      //    reves.
      expect(store.isConfigValid).toBe(true);
    });
  });

  describe('2. Selectores cerrados del origen', () => {
    it('2.1 no deberia ofrecer nada sin contexto aguas arriba', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const store = usePostIaSanitizerStore(nextNodeId());

      // 3. Assert 🎯
      expect(store.namespaceOptions).toEqual([]);
      expect(store.fieldOptions).toEqual([]);
    });

    it('2.2 deberia ofrecer los namespaces de los pasos anteriores', () => {
      // 1. Arrange 📐
      const store = usePostIaSanitizerStore(nextNodeId());

      // 2. Act ⚙️
      store.setAvailableUpstreamContext(FULL_UPSTREAM);

      // 3. Assert 🎯
      expect(store.namespaceOptions).toEqual(['rendered_html', 'llm_response']);
    });

    it('2.3 deberia ofrecer los campos del namespace elegido, y solo esos', () => {
      // 1. Arrange 📐: es lo que impide teclear una ruta que no existe, que en
      //    ejecucion seria ERR_POST_IA_EMPTY_HTML con el flujo ya PAUSADO.
      const store = usePostIaSanitizerStore(nextNodeId());
      store.setAvailableUpstreamContext(FULL_UPSTREAM);

      // 2. Act ⚙️
      const porDefecto = [...store.fieldOptions];
      store.updateConfig({ sourceNamespace: 'rendered_html' });

      // 3. Assert 🎯
      expect(porDefecto).toContain('filled_markup');
      expect(store.fieldOptions).toEqual(['compiled_markup', 'mapped_at']);
    });
  });

  describe('3. Avisos', () => {
    it('3.1 no deberia avisar de nada mientras el contexto esta vacio', () => {
      // 1. Arrange 📐: el catalogo todavia no ha cargado. Avisar aqui seria una
      //    falsa alarma en cada apertura del asistente.
      const store = usePostIaSanitizerStore(nextNodeId());

      // 2. Act ⚙️ + 3. Assert 🎯: solo queda el aviso de selectores, que no
      //    depende del contexto.
      expect(store.configWarnings.some((text) => text.includes('ningun paso anterior'))).toBe(
        false,
      );
      expect(store.configWarnings.some((text) => text.includes('MAPEADOR_PLANTILLA'))).toBe(false);
    });

    it('3.2 deberia senalar un origen que el flujo ya no produce', () => {
      // 1. Arrange 📐
      const store = usePostIaSanitizerStore(nextNodeId());
      store.setAvailableUpstreamContext(FULL_UPSTREAM);

      // 2. Act ⚙️
      store.updateConfig({ sourceNamespace: 'ocr_result' });

      // 3. Assert 🎯: no se borra en silencio, se senala. Borrarlo cambiaria la
      //    configuracion de un flujo sin que nadie lo pidiera.
      expect(store.hasStaleSource).toBe(true);
      expect(
        store.configWarnings.some((text) => text.includes('ERR_POST_IA_MISSING_PAYLOAD')),
      ).toBe(true);
    });

    it('3.3 deberia avisar si no hay plantilla base por delante', () => {
      // 1. Arrange 📐: sin mapeador, el PROCESADOR_IA no maqueta nada y el
      //    escudo se queda sin markup que auditar.
      const store = usePostIaSanitizerStore(nextNodeId());

      // 2. Act ⚙️
      store.setAvailableUpstreamContext([FULL_UPSTREAM[1] as UpstreamNamespace]);

      // 3. Assert 🎯
      expect(store.hasBaseTemplateUpstream).toBe(false);
      expect(store.configWarnings.some((text) => text.includes('MAPEADOR_PLANTILLA'))).toBe(true);
    });

    it('3.4 no deberia avisar con el mapeador por delante', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const store = usePostIaSanitizerStore(nextNodeId());
      store.setAvailableUpstreamContext(FULL_UPSTREAM);

      // 3. Assert 🎯: se detecta por el CAMPO `compiled_markup`, no por el tipo
      //    ni por el namespace, igual que en el backend.
      expect(store.hasBaseTemplateUpstream).toBe(true);
      expect(store.configWarnings.some((text) => text.includes('MAPEADOR_PLANTILLA'))).toBe(false);
    });

    it('3.5 deberia avisar de que sin selectores no detecta una mutilacion', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const store = usePostIaSanitizerStore(nextNodeId());

      // 3. Assert 🎯: sin este aviso, un escudo vacio parece proteger mas de lo
      //    que protege.
      expect(store.configWarnings.some((text) => text.includes('titular'))).toBe(true);
    });
  });

  describe('4. Validez', () => {
    it('4.1 deberia invalidar un origen vacio', () => {
      // 1. Arrange 📐
      const store = usePostIaSanitizerStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ sourceField: '  ' });

      // 3. Assert 🎯
      expect(store.isConfigValid).toBe(false);
    });

    it('4.2 deberia invalidar mas selectores de los que admite el DTO', () => {
      // 1. Arrange 📐: el backend responderia 400 sobre el esquema ENTERO, y el
      //    operador veria un error de guardado sin saber que campo lo causa.
      const store = usePostIaSanitizerStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({
        requiredSelectors: Array.from(
          { length: MAX_REQUIRED_SELECTORS + 1 },
          (_, index) => `.ranura-${index}`,
        ),
      });

      // 3. Assert 🎯
      expect(store.isConfigValid).toBe(false);
    });

    it('4.3 deberia invalidar un selector mas largo que el tope', () => {
      // 1. Arrange 📐
      const store = usePostIaSanitizerStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ requiredSelectors: ['a'.repeat(MAX_SELECTOR_LENGTH + 1)] });

      // 3. Assert 🎯
      expect(store.oversizedSelectors).toHaveLength(1);
      expect(store.isConfigValid).toBe(false);
    });

    it('4.4 deberia invalidar una etiqueta fuera de la lista blanca del saneador', () => {
      // 1. Arrange 📐: `allowedTags` solo puede RESTAR. Concederlo por parametro
      //    seria abrir XSS desde la configuracion de un nodo.
      const store = usePostIaSanitizerStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ allowedTags: ['h1', 'script'] });

      // 3. Assert 🎯
      expect(store.unsupportedTags).toEqual(['script']);
      expect(store.isConfigValid).toBe(false);
    });

    it('4.5 deberia admitir un subconjunto legitimo de la lista blanca', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const store = usePostIaSanitizerStore(nextNodeId());
      store.updateConfig({ allowedTags: ['h1', 'p', 'div', 'img'] });

      // 3. Assert 🎯
      expect(store.unsupportedTags).toEqual([]);
      expect(store.isConfigValid).toBe(true);
    });
  });

  describe('5. Contrato con el pipeline_schema', () => {
    it('5.1 no deberia publicar los defectos', () => {
      // 1. Arrange 📐 + 2. Act ⚙️: el backend resuelve el mismo valor con `??`,
      //    y publicarlo ademas aqui crearia dos sitios que mantener a la vez.
      const store = usePostIaSanitizerStore(nextNodeId());

      // 3. Assert 🎯
      expect(store.toNodeParams()).toEqual({});
    });

    it('5.2 deberia publicar un origen que difiere del defecto', () => {
      // 1. Arrange 📐
      const store = usePostIaSanitizerStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ sourceNamespace: 'ocr_result', sourceField: 'clean_body' });

      // 3. Assert 🎯
      expect(store.toNodeParams()).toEqual({
        sourceNamespace: 'ocr_result',
        sourceField: 'clean_body',
      });
    });

    it('5.3 NO deberia publicar outputNamespace', () => {
      // 1. Arrange 📐: en el esquema es propiedad del NODO, no de sus `params`.
      const store = usePostIaSanitizerStore(nextNodeId());

      // 2. Act ⚙️
      store.hydrateFromNode({ outputNamespace: 'validated_drupal_json', params: {} });

      // 3. Assert 🎯
      expect(store.toNodeParams()).not.toHaveProperty('outputNamespace');
    });

    it('5.4 deberia reproducir los params al hidratar y volver a publicar', () => {
      // 1. Arrange 📐: contrato de ida y vuelta del registro de stores.
      const store = usePostIaSanitizerStore(nextNodeId());
      const params = {
        sourceNamespace: 'ocr_result',
        sourceField: 'clean_body',
        requiredSelectors: ['h1.titular', 'div.cuerpo'],
        allowedTags: ['h1', 'div', 'p'],
      };

      // 2. Act ⚙️
      store.hydrateFromNode({ outputNamespace: 'validated_drupal_json', params });

      // 3. Assert 🎯
      expect(store.toNodeParams()).toEqual(params);
      expect(store.isConfigValid).toBe(true);
    });

    it('5.5 deberia cerrar la ida y vuelta de un nodo guardado sin origen', () => {
      // 1. Arrange 📐: el backend lo ejecutaria contra `llm_response.filled_markup`,
      //    asi que mostrarlo en blanco mentiria sobre de donde lee. Y como el
      //    repuesto COINCIDE con el defecto, `toNodeParams` vuelve a omitirlo.
      const store = usePostIaSanitizerStore(nextNodeId());

      // 2. Act ⚙️
      store.hydrateFromNode({ outputNamespace: 'validated_drupal_json', params: {} });

      // 3. Assert 🎯
      expect(store.config.sourceNamespace).toBe(DEFAULT_POST_IA_SOURCE_NAMESPACE);
      expect(store.config.sourceField).toBe(DEFAULT_POST_IA_SOURCE_FIELD);
      expect(store.toNodeParams()).toEqual({});
    });

    it('5.6 deberia tolerar un jsonb con basura en las listas', () => {
      // 1. Arrange 📐: la columna pudo escribirse por SQL directo. Un `null` en
      //    el arreglo dejaria un chip vacio imposible de borrar.
      const store = usePostIaSanitizerStore(nextNodeId());

      // 2. Act ⚙️
      store.hydrateFromNode({
        outputNamespace: 'validated_drupal_json',
        params: {
          sourceNamespace: 42,
          requiredSelectors: ['h1.titular', null, 7],
          allowedTags: 'no-es-un-arreglo',
        },
      });

      // 3. Assert 🎯
      expect(store.config.sourceNamespace).toBe(DEFAULT_POST_IA_SOURCE_NAMESPACE);
      expect(store.config.requiredSelectors).toEqual(['h1.titular']);
      expect(store.config.allowedTags).toEqual([]);
    });

    it('5.7 deberia volver al estado inicial al reiniciar', () => {
      // 1. Arrange 📐
      const store = usePostIaSanitizerStore(nextNodeId());
      store.setAvailableUpstreamContext(FULL_UPSTREAM);
      store.updateConfig({ sourceNamespace: 'ocr_result', requiredSelectors: ['h1'] });

      // 2. Act ⚙️
      store.resetConfig();

      // 3. Assert 🎯: la instancia sobrevive a la topologia que la creo, asi que
      //    sin esto un flujo nuevo arrancaria con los params del anterior.
      expect(store.config.sourceNamespace).toBe(DEFAULT_POST_IA_SOURCE_NAMESPACE);
      expect(store.config.requiredSelectors).toEqual([]);
      expect(store.namespaceOptions).toEqual([]);
    });
  });

  describe('6. Ranuras sugeridas desde la plantilla base', () => {
    const BASE_MARKUP =
      '<h1 class="titular"></h1><p class="resumen"></p><div class="row"></div><table></table>';

    it('6.1 NO deberia sugerir nada sin plantilla base aguas arriba', () => {
      // 1. Arrange 📐 & 2. Act ⚙️
      const store = usePostIaSanitizerStore(nextNodeId());

      // 3. Assert 🎯: es lo mismo que no haber llegado al paso del mapeador, y
      //    las dos cosas significan "todavia no hay nada que ofrecer".
      expect(store.detectedSelectorOptions).toEqual([]);
    });

    it('6.2 deberia derivar las ranuras del marcado que empuja el anfitrion', () => {
      // 1. Arrange 📐
      const store = usePostIaSanitizerStore(nextNodeId());

      // 2. Act ⚙️
      store.setUpstreamBaseMarkup(BASE_MARKUP);

      // 3. Assert 🎯: `.row` es maquetacion, no una ranura que rellenar.
      expect(store.detectedSelectorOptions).toEqual(['h1', 'table', '.titular', '.resumen']);
    });

    it('6.3 NO deberia volver a ofrecer una ranura ya elegida', () => {
      // 1. Arrange 📐
      const store = usePostIaSanitizerStore(nextNodeId());
      store.setUpstreamBaseMarkup(BASE_MARKUP);

      // 2. Act ⚙️
      store.updateConfig({ requiredSelectors: ['h1'] });

      // 3. Assert 🎯: ofrecer lo que ya es un chip hace que el desplegable
      //    parezca no responder al pulsarlo.
      expect(store.detectedSelectorOptions).not.toContain('h1');
    });

    it('6.4 deberia vaciar las sugerencias si el flujo pierde la plantilla', () => {
      // 1. Arrange 📐: el operador vuelve atras y deselecciona la plantilla.
      const store = usePostIaSanitizerStore(nextNodeId());
      store.setUpstreamBaseMarkup(BASE_MARKUP);

      // 2. Act ⚙️
      store.setUpstreamBaseMarkup(null);

      // 3. Assert 🎯
      expect(store.detectedSelectorOptions).toEqual([]);
    });
  });

  describe('7. Autocompletado de ranuras', () => {
    it('7.1 deberia cargar las ranuras detectadas', () => {
      // 1. Arrange 📐
      const store = usePostIaSanitizerStore(nextNodeId());
      store.setUpstreamBaseMarkup('<h1 class="titular"></h1>');

      // 2. Act ⚙️
      store.autoPopulateCriticalSelectors();

      // 3. Assert 🎯
      expect(store.config.requiredSelectors).toEqual(['h1', '.titular']);
    });

    it('7.2 deberia ANADIR sin perder lo que el operador ya escribio', () => {
      // 1. Arrange 📐: una ranura que la plantilla no declara pero que el
      //    operador espera del modelo tiene que sobrevivir al boton.
      const store = usePostIaSanitizerStore(nextNodeId());
      store.updateConfig({ requiredSelectors: ['.pie-de-foto'] });
      store.setUpstreamBaseMarkup('<h1></h1>');

      // 2. Act ⚙️
      store.autoPopulateCriticalSelectors();

      // 3. Assert 🎯: reemplazar convertiria un atajo en una trampa.
      expect(store.config.requiredSelectors).toEqual(['.pie-de-foto', 'h1']);
    });

    it('7.3 deberia cortar en el tope en vez de rechazar la operacion', () => {
      // 1. Arrange 📐: mas candidatos que huecos libres.
      const store = usePostIaSanitizerStore(nextNodeId());
      const markup = Array.from(
        { length: MAX_REQUIRED_SELECTORS + 5 },
        (_, index) => `<div class="titular-${index}"></div>`,
      ).join('');
      store.setUpstreamBaseMarkup(markup);

      // 2. Act ⚙️
      store.autoPopulateCriticalSelectors();

      // 3. Assert 🎯: llenar hasta el tope es lo que el operador ha pedido;
      //    fallar porque sobran candidatos no le acerca a su objetivo.
      expect(store.config.requiredSelectors).toHaveLength(MAX_REQUIRED_SELECTORS);
      expect(store.isConfigValid).toBe(true);
    });

    it('7.4 NO deberia tocar nada con el cupo ya lleno', () => {
      // 1. Arrange 📐
      const store = usePostIaSanitizerStore(nextNodeId());
      const full = Array.from({ length: MAX_REQUIRED_SELECTORS }, (_, i) => `.ranura-${i}`);
      store.updateConfig({ requiredSelectors: full });
      store.setUpstreamBaseMarkup('<h1></h1>');

      // 2. Act ⚙️
      store.autoPopulateCriticalSelectors();

      // 3. Assert 🎯
      expect(store.config.requiredSelectors).toEqual(full);
    });

    it('7.5 NO deberia hacer nada sin plantilla base', () => {
      // 1. Arrange 📐
      const store = usePostIaSanitizerStore(nextNodeId());

      // 2. Act ⚙️
      store.autoPopulateCriticalSelectors();

      // 3. Assert 🎯
      expect(store.config.requiredSelectors).toEqual([]);
    });
  });

  describe('8. Aislamiento entre nodos', () => {
    it('8.1 no deberia compartir estado entre dos escudos del mismo flujo', () => {
      // 1. Arrange 📐
      const tras_redaccion = usePostIaSanitizerStore(nextNodeId());
      const tras_vision = usePostIaSanitizerStore(nextNodeId());

      // 2. Act ⚙️
      tras_redaccion.updateConfig({ requiredSelectors: ['h1.titular'] });

      // 3. Assert 🎯
      expect(tras_vision.config.requiredSelectors).toEqual([]);
    });
  });

  describe('9. Modo TEXT: escudo sin MAPEADOR_PLANTILLA', () => {
    const LLM_ONLY: UpstreamNamespace[] = [
      {
        namespace: 'llm_response',
        nodeType: NodeType.PROCESADOR_IA,
        fields: [
          { name: 'headline', type: 'text' },
          { name: 'summary', type: 'text' },
        ],
      },
    ];

    it('9.1 no deberia avisar de la falta de mapeador en modo TEXT', () => {
      // 1. Arrange 📐
      const store = usePostIaSanitizerStore(nextNodeId());
      store.setAvailableUpstreamContext(LLM_ONLY);

      // 2. Act ⚙️
      store.updateConfig({ contentMode: PostIaContentMode.TEXT });

      // 3. Assert 🎯
      expect(store.isConfigValid).toBe(true);
      expect(store.configWarnings.some((warning) => warning.includes('MAPEADOR'))).toBe(false);
    });

    it('9.2 deberia publicar solo modo y campos, y volver por hydrateFromNode', () => {
      // 1. Arrange 📐
      const store = usePostIaSanitizerStore(nextNodeId());
      store.updateConfig({
        contentMode: PostIaContentMode.TEXT,
        sourceFields: ['headline'],
        requiredSelectors: ['h1'],
      });

      // 2. Act ⚙️
      const params = store.toNodeParams();
      const other = usePostIaSanitizerStore(nextNodeId());
      other.hydrateFromNode({ outputNamespace: 'validated_drupal_json', params });

      // 3. Assert 🎯
      expect(params).toEqual({ contentMode: 'TEXT', sourceFields: ['headline'] });
      expect(other.config.contentMode).toBe(PostIaContentMode.TEXT);
      expect(other.config.sourceFields).toEqual(['headline']);
    });

    it('9.3 deberia invalidar el modo TEXT sin campos y avisar de campos que no existen', () => {
      // 1. Arrange 📐
      const empty = usePostIaSanitizerStore(nextNodeId());
      const stale = usePostIaSanitizerStore(nextNodeId());
      stale.setAvailableUpstreamContext(LLM_ONLY);

      // 2. Act ⚙️
      empty.updateConfig({ contentMode: PostIaContentMode.TEXT, sourceFields: [] });
      stale.updateConfig({
        contentMode: PostIaContentMode.TEXT,
        sourceFields: ['headline', 'body_paragraphs'],
      });

      // 3. Assert 🎯
      expect(empty.isConfigValid).toBe(false);
      expect(stale.missingTextFields).toEqual(['body_paragraphs']);
      expect(stale.hasStaleSource).toBe(true);
    });
  });

  describe('10. Modo JSON: datos estructurados (Cerrar licitacion)', () => {
    /** El esquema del maestro de cierre de la 069. */
    const CLOSING_SCHEMA = {
      type: 'object',
      required: ['headline'],
      properties: { headline: { type: 'string', minLength: 1 } },
    };

    const LLM_ONLY: UpstreamNamespace[] = [
      {
        namespace: 'llm_response',
        nodeType: NodeType.PROCESADOR_IA,
        fields: [{ name: 'headline', type: 'text' }],
      },
    ];

    it('10.1 deberia conservar el jsonSchema en la ida y vuelta hydrate -> toNodeParams', () => {
      // 1. Arrange 📐: el escudo tal y como lo siembra la 069.
      const store = usePostIaSanitizerStore(nextNodeId());
      const params = {
        contentMode: 'JSON',
        sourceNamespace: 'llm_response',
        jsonSchema: CLOSING_SCHEMA,
      };

      // 2. Act ⚙️
      store.hydrateFromNode({ outputNamespace: 'validated_drupal_json', params });
      const roundTrip = store.toNodeParams();

      // 3. Assert 🎯: guardar desde el asistente no pierde el esquema. El
      //    namespace por defecto se omite, como en los demas modos.
      expect(store.isJsonMode).toBe(true);
      expect(store.jsonSchemaRequiredKeys).toEqual(['headline']);
      expect(roundTrip).toEqual({ contentMode: 'JSON', jsonSchema: CLOSING_SCHEMA });
      expect(roundTrip.jsonSchema).not.toBe(CLOSING_SCHEMA);
    });

    it('10.2 deberia validar solo el origen y no publicar campos, selectores ni etiquetas', () => {
      // 1. Arrange 📐: restos de un modo HTML anterior.
      const store = usePostIaSanitizerStore(nextNodeId());
      const empty = usePostIaSanitizerStore(nextNodeId());
      store.setAvailableUpstreamContext(LLM_ONLY);

      // 2. Act ⚙️
      store.updateConfig({
        contentMode: PostIaContentMode.JSON,
        jsonSchema: CLOSING_SCHEMA,
        sourceField: '',
        requiredSelectors: ['h1'],
        allowedTags: ['p'],
      });
      empty.updateConfig({ contentMode: PostIaContentMode.JSON, sourceNamespace: ' ' });

      // 3. Assert 🎯
      expect(store.isConfigValid).toBe(true);
      expect(store.hasStaleSource).toBe(false);
      expect(store.toNodeParams()).toEqual({ contentMode: 'JSON', jsonSchema: CLOSING_SCHEMA });
      expect(empty.isConfigValid).toBe(false);
    });

    it('10.3 deberia avisar si no hay esquema y nunca de la falta de mapeador', () => {
      // 1. Arrange 📐
      const store = usePostIaSanitizerStore(nextNodeId());
      store.setAvailableUpstreamContext(LLM_ONLY);

      // 2. Act ⚙️
      store.updateConfig({ contentMode: PostIaContentMode.JSON });
      const withoutSchema = [...store.configWarnings];
      store.updateConfig({ jsonSchema: CLOSING_SCHEMA });

      // 3. Assert 🎯
      expect(withoutSchema.some((warning) => warning.includes('jsonSchema'))).toBe(true);
      expect(withoutSchema.some((warning) => warning.includes('MAPEADOR'))).toBe(false);
      expect(store.configWarnings).toEqual([]);
    });

    it('10.4 deberia caer al modo por defecto ante un contentMode desconocido', () => {
      // 1. Arrange 📐: valor escrito a mano en el jsonb.
      const store = usePostIaSanitizerStore(nextNodeId());

      // 2. Act ⚙️
      store.hydrateFromNode({
        outputNamespace: 'validated_drupal_json',
        params: { contentMode: 'XML', jsonSchema: ['no', 'objeto'] },
      });

      // 3. Assert 🎯
      expect(store.config.contentMode).toBe(PostIaContentMode.HTML);
      expect(store.config.jsonSchema).toBeNull();
    });
  });
});
