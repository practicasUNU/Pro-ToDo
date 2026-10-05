import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';

import { NodeType } from '@/types/pipeline';
import {
  DEFAULT_POST_IA_SOURCE_FIELD,
  DEFAULT_POST_IA_SOURCE_NAMESPACE,
  MAX_REQUIRED_SELECTORS,
  MAX_SELECTOR_LENGTH,
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
      expect(store.configWarnings.some((text) => text.includes('ERR_POST_IA_MISSING_PAYLOAD'))).toBe(
        true,
      );
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

  describe('6. Aislamiento entre nodos', () => {
    it('6.1 no deberia compartir estado entre dos escudos del mismo flujo', () => {
      // 1. Arrange 📐
      const tras_redaccion = usePostIaSanitizerStore(nextNodeId());
      const tras_vision = usePostIaSanitizerStore(nextNodeId());

      // 2. Act ⚙️
      tras_redaccion.updateConfig({ requiredSelectors: ['h1.titular'] });

      // 3. Assert 🎯
      expect(tras_vision.config.requiredSelectors).toEqual([]);
    });
  });
});
