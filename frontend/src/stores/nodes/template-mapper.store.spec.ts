import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useTemplateMapperStore } from './template-mapper.store';

import type { HtmlTemplate } from '@/types/html-template';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/nodes/template-mapper.service', () => ({
  fetchSelectableTemplates: vi.fn(),
  compilePreview: vi.fn(),
}));

const TEMPLATE_ID = '5e2d1c4b-7a89-4f30-b1c2-6d5e4f3a2b10';

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
): ReturnType<typeof useTemplateMapperStore> => {
  const store = useTemplateMapperStore();

  store.availableTemplates = [buildTemplate(requiredVariables)];
  store.setTemplateId(TEMPLATE_ID);

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

      // 3. Assert: ambas raices estan en el default del store
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
      const store = useTemplateMapperStore();

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
  });

  describe('2. isConfigValid', () => {
    it('2.1 deberia ser falso sin plantilla', () => {
      // 1. Arrange & 2. Act
      const store = useTemplateMapperStore();

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
});
