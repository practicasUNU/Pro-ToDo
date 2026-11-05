import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useTemplateMapperStore } from './template-mapper.store';

import { NodeType } from '@/types/pipeline';
import { AUDIT_FIXTURE } from '@/testing/audit.fixture';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

import type { HtmlTemplate } from '@/types/html-template';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/nodes/template-mapper.service', () => ({
  fetchSelectableTemplates: vi.fn(),
}));

/**
 * `nodeId` del nodo bajo prueba.
 *
 * El store se instancia POR NODO, asi que toda prueba tiene que nombrar el nodo
 * al que pregunta.
 */
const NODE_ID = 'nodo_mapeador';

const TEMPLATE_ID = '5e2d1c4b-7a89-4f30-b1c2-6d5e4f3a2b10';

/**
 * Contexto RICO, con el inventario que el catalogo publica por tipo de nodo.
 *
 * Desde el cambio de semantica ya no alimenta ninguna validacion: solo viaja al
 * editor de plantillas y sirve para detectar el orden invertido del flujo.
 */
const RICH_UPSTREAM: UpstreamNamespace[] = [
  {
    namespace: 'raw_email',
    nodeType: NodeType.TRIGGER_IMAP,
    fields: [
      { name: 'subject', type: 'text', description: 'Asunto del correo' },
      { name: 'attachments', type: 'object' },
    ],
  },
  {
    namespace: 'parsed_email',
    nodeType: NodeType.PARSER_PRE_IA,
    fields: [
      { name: 'clean_title', type: 'text' },
      { name: 'extracted_urls', type: 'url[]' },
    ],
  },
  { namespace: 'scraped_web', nodeType: NodeType.EXTRACTOR_WEB, fields: [] },
];

const buildTemplate = (requiredVariables: string[]): HtmlTemplate => ({
  ...AUDIT_FIXTURE,
  id: TEMPLATE_ID,
  name: 'noticia-basica',
  description: null,
  htmlContent: '<h1 class="titular"></h1>',
  requiredVariables,
  createdById: '9c1f7b52-4d3a-4e6b-8f2c-1a0b9d8e7f60',
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

/** Store con una plantilla ya seleccionada. */
const buildStoreWithTemplate = (
  requiredVariables: string[] = [],
): ReturnType<typeof useTemplateMapperStore> => {
  const store = useTemplateMapperStore(NODE_ID);

  store.availableTemplates = [buildTemplate(requiredVariables)];
  store.setTemplateId(TEMPLATE_ID);

  return store;
};

/** Store con la plantilla elegida y el inventario del flujo sembrado. */
const buildStoreWithContext = (
  requiredVariables: string[] = [],
  context: UpstreamNamespace[] = RICH_UPSTREAM,
): ReturnType<typeof useTemplateMapperStore> => {
  const store = buildStoreWithTemplate(requiredVariables);

  store.setAvailableUpstreamContext(context);

  return store;
};

describe('useTemplateMapperStore · inyeccion de plantilla base', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  describe('1. isConfigValid', () => {
    it('1.1 deberia ser falso sin plantilla', () => {
      // 1. Arrange
      const store = useTemplateMapperStore(NODE_ID);

      // 2. Act & 3. Assert
      expect(store.isConfigValid).toBe(false);
    });

    it('1.2 deberia ser verdadero con plantilla y namespace valido', () => {
      // 1. Arrange
      const store = buildStoreWithTemplate();

      // 2. Act & 3. Assert
      expect(store.isConfigValid).toBe(true);
    });

    it('1.3 deberia ser falso con un outputNamespace que el backend rechazaria', () => {
      // 1. Arrange: validarlo aqui evita un 400 sobre el esquema entero
      const store = buildStoreWithTemplate();

      // 2. Act
      store.setOutputNamespace('rendered-html');

      // 3. Assert
      expect(store.isConfigValid).toBe(false);
    });

    it('1.4 deberia ser verdadero aunque el flujo no provea las variables de la plantilla', () => {
      // 1. Arrange: PRUEBA DE REGRESION del bloqueo suprimido. Antes esto era
      //    `false` y detenia el asistente; el nodo ya no interpola, asi que lo
      //    que la plantilla pidiera al contexto no es precondicion suya.
      const store = buildStoreWithContext(['raw_email.body_inexistente']);

      // 2. Act & 3. Assert
      expect(store.isConfigValid).toBe(true);
    });

    it('1.5 no deberia reaccionar a un cambio de topologia', () => {
      // 1. Arrange
      const store = buildStoreWithContext(['parsed_email.clean_title']);
      expect(store.isConfigValid).toBe(true);

      // 2. Act: se vacia el flujo entero aguas arriba
      store.setAvailableUpstreamContext([]);

      // 3. Assert: la validez del paso no depende de quien va delante
      expect(store.isConfigValid).toBe(true);
    });

    it('1.6 deberia ser verdadero con una plantilla sin variables', () => {
      // 1. Arrange
      const store = buildStoreWithTemplate([]);

      // 2. Act & 3. Assert
      expect(store.isConfigValid).toBe(true);
    });
  });

  describe('2. configWarnings', () => {
    it('2.1 deberia avisar, SIN bloquear, de una plantilla que aun interpola', () => {
      // 1. Arrange: espejo en diseno de la guarda del backend
      const store = buildStoreWithTemplate(['parsed_email.clean_title']);

      // 2. Act & 3. Assert
      expect(store.configWarnings).toHaveLength(1);
      expect(store.configWarnings[0]).toContain('ERR_TEMPLATE_PENDING_VARS');
      expect(store.configWarnings[0]).toContain('parsed_email.clean_title');
      expect(store.isConfigValid).toBe(true);
    });

    it('2.2 no deberia avisar de nada con una plantilla esqueleto', () => {
      // 1. Arrange
      const store = buildStoreWithContext([]);

      // 2. Act & 3. Assert
      expect(store.configWarnings).toEqual([]);
    });

    it('2.3 deberia avisar si el PROCESADOR_IA va por delante de este nodo', () => {
      // 1. Arrange: con la inferencia aguas arriba, nadie rellena la plantilla
      const store = buildStoreWithContext(
        [],
        [{ namespace: 'llm_response', nodeType: NodeType.PROCESADOR_IA, fields: [] }],
      );

      // 2. Act & 3. Assert
      expect(store.configWarnings).toHaveLength(1);
      expect(store.configWarnings[0]).toContain('ANTES de este nodo');
      expect(store.isConfigValid).toBe(true);
    });

    it('2.4 deberia acumular los dos avisos cuando concurren', () => {
      // 1. Arrange
      const store = buildStoreWithContext(
        ['parsed_email.clean_title'],
        [{ namespace: 'llm_response', nodeType: NodeType.PROCESADOR_IA, fields: [] }],
      );

      // 2. Act & 3. Assert
      expect(store.configWarnings).toHaveLength(2);
      expect(store.isConfigValid).toBe(true);
    });

    it('2.5 no deberia avisar sin plantilla elegida', () => {
      // 1. Arrange
      const store = useTemplateMapperStore(NODE_ID);

      // 2. Act & 3. Assert
      expect(store.configWarnings).toEqual([]);
    });
  });

  describe('3. Canal rico del anfitrion', () => {
    it('3.1 deberia arrancar sin contexto declarado', () => {
      // 1. Arrange
      const store = useTemplateMapperStore(NODE_ID);

      // 2. Act & 3. Assert
      expect(store.availableUpstreamContext).toEqual([]);
    });

    it('3.2 deberia copiar el contexto recibido y no guardar la referencia', () => {
      // 1. Arrange: el anfitrion reconstruye su arreglo en cada sincronizacion
      const store = useTemplateMapperStore(NODE_ID);
      const context: UpstreamNamespace[] = [...RICH_UPSTREAM];

      // 2. Act
      store.setAvailableUpstreamContext(context);
      context.length = 0;

      // 3. Assert
      expect(store.availableUpstreamContext).toHaveLength(RICH_UPSTREAM.length);
    });

    it('3.3 deberia reaccionar a un cambio de topologia sin recrear el store', () => {
      // 1. Arrange
      const store = buildStoreWithContext([]);

      // 2. Act
      store.setAvailableUpstreamContext([]);

      // 3. Assert
      expect(store.availableUpstreamContext).toEqual([]);
    });
  });

  describe('4. Contrato con el anfitrion', () => {
    it('4.1 deberia publicar solo templateId en los params del esquema', () => {
      // 1. Arrange: `outputNamespace` es propiedad del NODO, no de sus params;
      //    duplicarlo crearia dos fuentes de verdad en el mismo JSON.
      const store = buildStoreWithTemplate();

      // 2. Act & 3. Assert
      expect(store.toNodeParams()).toEqual({ templateId: TEMPLATE_ID });
    });

    it('4.2 deberia rehidratar un nodo ya guardado y reproducir sus params', () => {
      // 1. Arrange
      const store = useTemplateMapperStore(NODE_ID);

      // 2. Act
      store.hydrateFromNode({
        outputNamespace: 'rendered_html',
        params: { templateId: TEMPLATE_ID },
      });

      // 3. Assert
      expect(store.toNodeParams()).toEqual({ templateId: TEMPLATE_ID });
      expect(store.config.outputNamespace).toBe('rendered_html');
    });

    it('4.3 deberia conservar el namespace por defecto si llega vacio', () => {
      // 1. Arrange: un namespace en blanco no pasaria el patron y dejaria el
      //    paso invalido sin que el operador entienda por que.
      const store = useTemplateMapperStore(NODE_ID);

      // 2. Act
      store.hydrateFromNode({
        outputNamespace: '',
        params: { templateId: TEMPLATE_ID },
      });

      // 3. Assert
      expect(store.config.outputNamespace).toBe('rendered_html');
    });

    it('4.4 deberia dejar el paso invalido al reiniciar la configuracion', () => {
      // 1. Arrange
      const store = buildStoreWithTemplate();

      // 2. Act
      store.resetConfig();

      // 3. Assert
      expect(store.config.templateId).toBeNull();
      expect(store.isConfigValid).toBe(false);
    });
  });
});
