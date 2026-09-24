import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useTemplateMapperStore } from './template-mapper.store';

import { NodeType } from '@/types/pipeline';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

import type { HtmlTemplate } from '@/types/html-template';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/nodes/template-mapper.service', () => ({
  fetchSelectableTemplates: vi.fn(),
  compilePreview: vi.fn(),
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
 * Namespaces que el anfitrion declara por el canal de NOMBRES.
 *
 * Se siembran en cada prueba en vez de venir de un default del store: el store
 * arranca vacio a proposito desde que el asistente empuja el contexto de verdad,
 * y un default no vacio validaba el nodo contra un flujo inventado.
 */
const SEEDED_NAMESPACES = ['parsed_email', 'scraped_web', 'llm_response'];

/**
 * Contexto RICO, con el inventario que el catalogo publica por tipo de nodo.
 *
 * `raw_email` entra con campos y `scraped_web` sin ellos a proposito: son los
 * dos caminos que `missingRequiredVariables` distingue —inventario conocido
 * frente a "aun no se que publica"— y el segundo no debe reportar nada.
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
  id: TEMPLATE_ID,
  name: 'noticia-basica',
  description: null,
  htmlContent: '<h1>x</h1>',
  requiredVariables,
  createdById: '9c1f7b52-4d3a-4e6b-8f2c-1a0b9d8e7f60',
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

/** Store con una plantilla ya seleccionada y sus variables requeridas. */
const buildStoreWithTemplate = (
  requiredVariables: string[],
  namespaces: string[] = SEEDED_NAMESPACES,
): ReturnType<typeof useTemplateMapperStore> => {
  const store = useTemplateMapperStore(NODE_ID);

  store.availableTemplates = [buildTemplate(requiredVariables)];
  store.setTemplateId(TEMPLATE_ID);
  store.setAvailableUpstreamNamespaces(namespaces);

  return store;
};

/** Store con los dos canales sembrados: nombres e inventario. */
const buildStoreWithContext = (
  requiredVariables: string[],
  context: UpstreamNamespace[] = RICH_UPSTREAM,
): ReturnType<typeof useTemplateMapperStore> => {
  const store = buildStoreWithTemplate(
    requiredVariables,
    context.map(({ namespace }) => namespace),
  );

  store.setAvailableUpstreamContext(context);

  return store;
};

describe('useTemplateMapperStore · contrato de namespaces', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  describe('1. missingRequiredVariables', () => {
    it('1.1 no deberia reportar nada si el flujo provee todas las raices', () => {
      // 1. Arrange & 2. Act
      const store = buildStoreWithTemplate(['parsed_email.clean_title', 'llm_response.summary']);

      // 3. Assert: ambas raices estan entre las declaradas por el anfitrion
      expect(store.missingRequiredVariables).toEqual([]);
    });

    it('1.2 deberia reportar la variable cuya raiz no produce ningun nodo previo', () => {
      // 1. Arrange & 2. Act
      const store = buildStoreWithTemplate([
        'parsed_email.clean_title',
        'validated_drupal_json.body',
      ]);

      // 3. Assert
      expect(store.missingRequiredVariables).toEqual(['validated_drupal_json.body']);
    });

    it('1.3 deberia validar la RAIZ de una ruta profunda, no la ruta entera', () => {
      // 1. Arrange & 2. Act
      const store = buildStoreWithTemplate(['llm_response.articles.0.title']);

      // 3. Assert: `llm_response` si lo provee el flujo, asi que la ruta vale
      expect(store.missingRequiredVariables).toEqual([]);
    });

    it('1.4 deberia estar vacio sin plantilla seleccionada', () => {
      // 1. Arrange & 2. Act
      const store = useTemplateMapperStore(NODE_ID);

      // 3. Assert
      expect(store.missingRequiredVariables).toEqual([]);
    });

    it('1.5 deberia recalcularse al cambiar los namespaces disponibles', () => {
      // 1. Arrange
      const store = buildStoreWithTemplate(['scraped_web.headline']);
      expect(store.missingRequiredVariables).toEqual([]);

      // 2. Act
      store.setAvailableUpstreamNamespaces(['parsed_email']);

      // 3. Assert
      expect(store.missingRequiredVariables).toEqual(['scraped_web.headline']);
    });

    it('1.6 deberia arrancar SIN namespaces y no dar nada por resoluble', () => {
      // 1. Arrange: sin sembrar. Antes el store nacia con tres namespaces
      // inventados y validaba el nodo contra un flujo que no existe.
      const store = useTemplateMapperStore(NODE_ID);
      store.availableTemplates = [buildTemplate(['parsed_email.clean_title'])];
      store.setTemplateId(TEMPLATE_ID);

      // 2. Act & 3. Assert
      expect(store.availableUpstreamNamespaces).toEqual([]);
      expect(store.missingRequiredVariables).toEqual(['parsed_email.clean_title']);
    });
  });

  describe('2. isConfigValid', () => {
    it('2.1 deberia ser falso sin plantilla', () => {
      // 1. Arrange & 2. Act
      const store = useTemplateMapperStore(NODE_ID);

      // 3. Assert
      expect(store.isConfigValid).toBe(false);
    });

    it('2.2 deberia ser verdadero con plantilla, namespace valido y contrato completo', () => {
      // 1. Arrange & 2. Act
      const store = buildStoreWithTemplate(['parsed_email.clean_title']);

      // 3. Assert
      expect(store.isConfigValid).toBe(true);
    });

    it('2.3 deberia ser falso con un outputNamespace que el backend rechazaria', () => {
      // 1. Arrange
      const store = buildStoreWithTemplate(['parsed_email.clean_title']);

      // 2. Act: OUTPUT_NAMESPACE_PATTERN no admite guiones
      store.setOutputNamespace('rendered-html');

      // 3. Assert
      expect(store.isConfigValid).toBe(false);
    });

    it('2.4 deberia ser falso si falta un namespace requerido', () => {
      // 1. Arrange & 2. Act
      const store = buildStoreWithTemplate(['raw_email.body']);

      // 3. Assert: Poka-Yoke — no se avanza con un contrato que se sabe roto
      expect(store.isConfigValid).toBe(false);
    });

    it('2.5 deberia conmutar en vivo al quitar y devolver un namespace', () => {
      // 1. Arrange
      const store = buildStoreWithTemplate(['scraped_web.headline']);
      expect(store.isConfigValid).toBe(true);

      // 2. Act & 3. Assert: es lo que el banco de pruebas deja verificar a mano
      store.setAvailableUpstreamNamespaces(['parsed_email', 'llm_response']);
      expect(store.isConfigValid).toBe(false);

      store.setAvailableUpstreamNamespaces(['parsed_email', 'scraped_web', 'llm_response']);
      expect(store.isConfigValid).toBe(true);
    });

    it('2.6 deberia ser verdadero con una plantilla sin variables', () => {
      // 1. Arrange & 2. Act
      const store = buildStoreWithTemplate([]);

      // 3. Assert: una plantilla estatica no exige nada al contexto
      expect(store.isConfigValid).toBe(true);
    });
  });

  describe('3. Canal rico del anfitrion', () => {
    it('3.1 deberia arrancar sin contexto y sin opciones que ofrecer', () => {
      // 1. Arrange & 2. Act
      const store = useTemplateMapperStore(NODE_ID);

      // 3. Assert
      expect(store.availableUpstreamContext).toEqual([]);
      expect(store.variableOptions).toEqual([]);
      expect(store.hasUpstreamVariables).toBe(false);
    });

    it('3.2 deberia copiar el contexto recibido y no guardar la referencia', () => {
      // 1. Arrange: el anfitrion reconstruye su arreglo en cada sincronizacion.
      const store = useTemplateMapperStore(NODE_ID);
      const context: UpstreamNamespace[] = [...RICH_UPSTREAM];

      // 2. Act
      store.setAvailableUpstreamContext(context);
      context.push({ namespace: 'http_result', nodeType: NodeType.DESTINO_HTTP, fields: [] });

      // 3. Assert
      expect(store.availableUpstreamContext).toHaveLength(RICH_UPSTREAM.length);
    });

    it('3.3 deberia reaccionar a un cambio de topologia sin recrear el store', () => {
      // 1. Arrange
      const store = buildStoreWithContext([]);
      expect(store.hasUpstreamVariables).toBe(true);

      // 2. Act: el operador retrocede y quita el nodo que publicaba campos
      store.setAvailableUpstreamContext([]);

      // 3. Assert
      expect(store.variableOptions).toEqual([]);
      expect(store.hasUpstreamVariables).toBe(false);
    });
  });

  describe('4. variableOptions', () => {
    it('4.1 deberia componer label, value y group de cada campo publicado', () => {
      // 1. Arrange & 2. Act
      const store = buildStoreWithContext([]);

      // 3. Assert: `value` es el marcador listo para pegar en la plantilla.
      expect(store.variableOptions[0]).toEqual({
        label: 'subject (text)',
        value: '{{raw_email.subject}}',
        group: 'raw_email (TRIGGER_IMAP)',
      });
    });

    it('4.2 deberia ofrecer una opcion por campo de TODOS los namespaces', () => {
      // 1. Arrange & 2. Act
      const store = buildStoreWithContext([]);

      // 3. Assert: dos de `raw_email` y dos de `parsed_email`; `scraped_web` no
      // aporta ninguna porque llega sin inventario.
      expect(store.variableOptions.map((option) => option.value)).toEqual([
        '{{raw_email.subject}}',
        '{{raw_email.attachments}}',
        '{{parsed_email.clean_title}}',
        '{{parsed_email.extracted_urls}}',
      ]);
    });

    it('4.3 NO deberia filtrar por tipo, a diferencia del extractor web', () => {
      // 1. Arrange & 2. Act
      const store = buildStoreWithContext([]);

      // 3. Assert: una plantilla interpola cualquier cosa que sepa convertirse
      // en texto, asi que el `object` y el `url[]` tambien se ofrecen.
      expect(store.variableOptions.map((option) => option.label)).toContain('attachments (object)');
      expect(store.variableOptions.map((option) => option.label)).toContain(
        'extracted_urls (url[])',
      );
    });

    it('4.4 deberia etiquetar sin parentesis un namespace sin tipo de nodo', () => {
      // 1. Arrange: `_assets` no lo escribe ningun nodo; lo inyecta el backend.
      const store = useTemplateMapperStore(NODE_ID);

      // 2. Act
      store.setAvailableUpstreamContext([
        { namespace: '_assets', fields: [{ name: 'base_url', type: 'text' }] },
      ]);

      // 3. Assert
      expect(store.variableOptions[0]?.group).toBe('_assets');
    });
  });

  describe('5. Grano fino de missingRequiredVariables', () => {
    it('5.1 deberia reportar el campo que el namespace presente NO publica', () => {
      // 1. Arrange & 2. Act: `parsed_email` esta aguas arriba, pero no publica
      // `clean_body`. Hasta ahora esto pasaba por bueno y reventaba en ejecucion.
      const store = buildStoreWithContext(['parsed_email.clean_body']);

      // 3. Assert
      expect(store.missingRequiredVariables).toEqual(['parsed_email.clean_body']);
      expect(store.isConfigValid).toBe(false);
    });

    it('5.2 no deberia reportar un campo que si esta en el inventario', () => {
      // 1. Arrange & 2. Act
      const store = buildStoreWithContext(['parsed_email.clean_title', 'raw_email.subject']);

      // 3. Assert
      expect(store.missingRequiredVariables).toEqual([]);
      expect(store.isConfigValid).toBe(true);
    });

    it('5.3 no deberia reportar nada de un namespace con inventario vacio', () => {
      // 1. Arrange & 2. Act: `scraped_web` llega sin campos. Vacio significa "aun
      // no se que publica" —catalogo sin cargar, o tipo sin declarar—, nunca un
      // error: tratarlo como fallo marcaria en rojo cada plantilla al arrancar.
      const store = buildStoreWithContext(['scraped_web.article_title']);

      // 3. Assert
      expect(store.missingRequiredVariables).toEqual([]);
      expect(store.isConfigValid).toBe(true);
    });

    it('5.4 deberia juzgar una ruta profunda por sus dos primeros segmentos', () => {
      // 1. Arrange: lo que el nodo publica es `attachments`; `.0.filename` es la
      // forma de DENTRO del objeto, que ninguna estrategia declara campo a campo.
      const store = buildStoreWithContext([
        'raw_email.attachments.0.filename',
        'raw_email.no_existe.0.x',
      ]);

      // 2. Act & 3. Assert
      expect(store.missingRequiredVariables).toEqual(['raw_email.no_existe.0.x']);
    });

    it('5.5 deberia separar el fallo de namespace del fallo de campo', () => {
      // 1. Arrange & 2. Act: los dos arreglos son distintos —anadir un nodo, o
      // corregir la plantilla— y el componente los enuncia por separado.
      const store = buildStoreWithContext([
        'validated_drupal_json.body',
        'parsed_email.clean_body',
      ]);

      // 3. Assert
      expect(store.missingUpstreamNamespaces).toEqual(['validated_drupal_json']);
      expect(store.missingUpstreamFields).toEqual(['parsed_email.clean_body']);
    });
  });

  describe('6. hasUpstreamVariables', () => {
    it('6.1 no deberia invalidar una plantilla estatica sin nada aguas arriba', () => {
      // 1. Arrange & 2. Act: un pie corporativo no interpola nada, y exigirle
      // contexto seria inventar un requisito que el motor no tiene.
      const store = buildStoreWithTemplate([], []);

      // 3. Assert
      expect(store.hasUpstreamVariables).toBe(false);
      expect(store.isConfigValid).toBe(true);
    });

    it('6.2 deberia ser verdadero en cuanto un paso anterior publique un campo', () => {
      // 1. Arrange & 2. Act
      const store = buildStoreWithContext([]);

      // 3. Assert
      expect(store.hasUpstreamVariables).toBe(true);
    });
  });
});
