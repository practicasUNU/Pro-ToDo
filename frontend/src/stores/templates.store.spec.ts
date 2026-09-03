import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useTemplatesStore } from './templates.store';

import type { HtmlTemplate } from '@/types/html-template';

// El servicio se sustituye por completo: sin esto se cargaria `@boot/axios`, que
// necesita un entorno de navegador. El store se prueba aislado de la red.
vi.mock('@services/templates.service', () => ({
  fetchTemplates: vi.fn(),
  fetchTemplateById: vi.fn(),
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deactivateTemplate: vi.fn(),
  previewTemplate: vi.fn(),
}));

const AUTHOR_ID = '9c1f7b52-4d3a-4e6b-8f2c-1a0b9d8e7f60';
const TEMPLATE_ID = '5e2d1c4b-7a89-4f30-b1c2-6d5e4f3a2b10';

/** Plantilla completa; los tests sobrescriben solo lo que les concierne. */
const buildTemplate = (overrides: Partial<HtmlTemplate> = {}): HtmlTemplate => ({
  id: TEMPLATE_ID,
  name: 'noticia-basica',
  description: 'Cuerpo de noticia con titular',
  htmlContent: '<h1>{{parsed_email.clean_title}}</h1>',
  requiredVariables: ['parsed_email.clean_title'],
  createdById: AUTHOR_ID,
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('useTemplatesStore · borrador de edicion', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  describe('1. initDraft', () => {
    it('1.1 deberia dejar el borrador vacio y el cursor en 0 sin argumento', () => {
      // 1. Arrange
      const store = useTemplatesStore();
      store.setCursorPosition(42);

      // 2. Act
      store.initDraft();

      // 3. Assert
      expect(store.activeDraft.name).toBe('');
      expect(store.activeDraft.htmlContent).toBe('');
      expect(store.cursorPosition).toBe(0);
    });

    it('1.2 deberia cargar los datos de la plantilla a editar', () => {
      // 1. Arrange
      const store = useTemplatesStore();

      // 2. Act
      store.initDraft(buildTemplate());

      // 3. Assert
      expect(store.activeDraft.name).toBe('noticia-basica');
      expect(store.activeDraft.description).toBe('Cuerpo de noticia con titular');
      expect(store.activeDraft.htmlContent).toBe('<h1>{{parsed_email.clean_title}}</h1>');
    });

    it('1.3 deberia OMITIR la clave description cuando la entidad trae null', () => {
      // 1. Arrange
      const store = useTemplatesStore();

      // 2. Act
      store.initDraft(buildTemplate({ description: null }));

      // 3. Assert: `exactOptionalPropertyTypes` prohibe asignar `undefined`; la
      // clave no debe existir, no basta con que valga undefined.
      expect('description' in store.activeDraft).toBe(false);
    });

    it('1.4 deberia descartar por completo el borrador anterior', () => {
      // 1. Arrange
      const store = useTemplatesStore();
      store.initDraft(buildTemplate());

      // 2. Act
      store.initDraft();

      // 3. Assert: sin esto, abrir "Nueva plantilla" tras editar arrastraria los
      // datos de la anterior
      expect(store.activeDraft.name).toBe('');
      expect('description' in store.activeDraft).toBe(false);
    });
  });

  describe('2. isDraftValid', () => {
    it('2.1 deberia ser falso con el borrador recien inicializado', () => {
      // 1. Arrange & 2. Act
      const store = useTemplatesStore();
      store.initDraft();

      // 3. Assert
      expect(store.isDraftValid).toBe(false);
    });

    it('2.2 deberia ser falso si el nombre son solo espacios', () => {
      // 1. Arrange
      const store = useTemplatesStore();
      store.initDraft();

      // 2. Act
      store.activeDraft.name = '   ';
      store.updateHtmlContent('<p>contenido</p>');

      // 3. Assert
      expect(store.isDraftValid).toBe(false);
    });

    it('2.3 deberia ser falso si el HTML son solo espacios', () => {
      // 1. Arrange
      const store = useTemplatesStore();
      store.initDraft();

      // 2. Act
      store.activeDraft.name = 'valida';
      store.updateHtmlContent('   \n  ');

      // 3. Assert
      expect(store.isDraftValid).toBe(false);
    });

    it('2.4 deberia ser verdadero con nombre y contenido', () => {
      // 1. Arrange & 2. Act
      const store = useTemplatesStore();
      store.initDraft(buildTemplate());

      // 3. Assert
      expect(store.isDraftValid).toBe(true);
    });
  });

  describe('3. detectedVariables', () => {
    it('3.1 deberia detectar varias rutas en orden de aparicion', () => {
      // 1. Arrange
      const store = useTemplatesStore();
      store.initDraft();

      // 2. Act
      store.updateHtmlContent(
        '<h1>{{parsed_email.clean_title}}</h1><p>{{ llm_response.summary }}</p>',
      );

      // 3. Assert
      expect(store.detectedVariables).toEqual(['parsed_email.clean_title', 'llm_response.summary']);
    });

    it('3.2 deberia deduplicar conservando el orden', () => {
      // 1. Arrange
      const store = useTemplatesStore();
      store.initDraft();

      // 2. Act
      store.updateHtmlContent(
        '<h1>{{llm_response.title}}</h1><h2>{{llm_response.title}}</h2><p>{{raw_email.body}}</p>',
      );

      // 3. Assert
      expect(store.detectedVariables).toEqual(['llm_response.title', 'raw_email.body']);
    });

    it('3.3 deberia aceptar rutas profundas y con indice', () => {
      // 1. Arrange
      const store = useTemplatesStore();
      store.initDraft();

      // 2. Act
      store.updateHtmlContent(
        '<h2>{{llm_response.articles.[0].title}}</h2><p>{{scraped_web.meta.author}}</p>',
      );

      // 3. Assert: el backend acepta ambas; si aqui no se detectaran, los chips
      // mostrarian menos variables de las que se van a guardar
      expect(store.detectedVariables).toEqual([
        'llm_response.articles.[0].title',
        'scraped_web.meta.author',
      ]);
    });

    it('3.4 deberia ignorar un namespace suelto sin ruta', () => {
      // 1. Arrange
      const store = useTemplatesStore();
      store.initDraft();

      // 2. Act
      store.updateHtmlContent('<h1>{{titulo}}</h1>');

      // 3. Assert: `{{titulo}}` no es interpolable, y el backend lo rechaza
      expect(store.detectedVariables).toEqual([]);
    });

    it('3.5 deberia detectar la FORMA y no la lista blanca', () => {
      // 1. Arrange
      const store = useTemplatesStore();
      store.initDraft();

      // 2. Act
      store.updateHtmlContent('<p>{{contacto.telefono}}</p>');

      // 3. Assert: aparece detectada aunque el backend la vaya a rechazar con un
      // 400. El gestor de plantillas es la unica autoridad sobre los namespaces
      expect(store.detectedVariables).toEqual(['contacto.telefono']);
    });

    it('3.6 deberia devolver un arreglo vacio sin marcadores', () => {
      // 1. Arrange
      const store = useTemplatesStore();
      store.initDraft();

      // 2. Act
      store.updateHtmlContent('<p>Texto fijo sin marcadores</p>');

      // 3. Assert
      expect(store.detectedVariables).toEqual([]);
    });

    it('3.7 deberia recalcularse en cada cambio de contenido', () => {
      // 1. Arrange
      const store = useTemplatesStore();
      store.initDraft();
      store.updateHtmlContent('<p>{{raw_email.body}}</p>');
      expect(store.detectedVariables).toEqual(['raw_email.body']);

      // 2. Act
      store.updateHtmlContent('<p>{{scraped_web.headline}}</p>');

      // 3. Assert: el regex es global y con estado; recorrerlo mal dejaria
      // resultados pegados de la evaluacion anterior
      expect(store.detectedVariables).toEqual(['scraped_web.headline']);
    });
  });

  describe('4. insertMarker (fallback sin editor montado)', () => {
    it('4.1 deberia insertar en el cursor y no al final', () => {
      // 1. Arrange
      const store = useTemplatesStore();
      store.initDraft();
      store.updateHtmlContent('<h1></h1>');
      store.setCursorPosition(4);

      // 2. Act
      store.insertMarker('parsed_email');

      // 3. Assert
      expect(store.activeDraft.htmlContent).toBe('<h1>{{parsed_email.}}</h1>');
    });

    it('4.2 deberia dejar el caret justo antes de las llaves de cierre', () => {
      // 1. Arrange
      const store = useTemplatesStore();
      store.initDraft();
      store.setCursorPosition(0);

      // 2. Act
      store.insertMarker('llm_response');

      // 3. Assert: `{{llm_response.|}}` — 17 caracteres hasta el punto, y el
      // caret retrocede los 2 de `}}` para poder escribir el campo
      expect(store.cursorPosition).toBe('{{llm_response.'.length);
      expect(store.activeDraft.htmlContent.slice(store.cursorPosition)).toBe('}}');
    });

    it('4.3 deberia acotar un cursor que quedo por delante del contenido', () => {
      // 1. Arrange
      const store = useTemplatesStore();
      store.initDraft();
      store.updateHtmlContent('<p></p>');

      // 2. Act: el espejo quedo desfasado tras un initDraft con texto mas corto
      store.setCursorPosition(999);
      store.insertMarker('raw_email');

      // 3. Assert: se inserta al final, sin dejar un hueco
      expect(store.activeDraft.htmlContent).toBe('<p></p>{{raw_email.}}');
    });

    it('4.4 deberia dejar el marcador insertado visible en detectedVariables al completarlo', () => {
      // 1. Arrange
      const store = useTemplatesStore();
      store.initDraft();
      store.setCursorPosition(0);

      // 2. Act
      store.insertMarker('parsed_email');
      // El marcador a medias (`{{parsed_email.}}`) aun no es una ruta valida
      expect(store.detectedVariables).toEqual([]);
      store.updateHtmlContent('{{parsed_email.clean_title}}');

      // 3. Assert
      expect(store.detectedVariables).toEqual(['parsed_email.clean_title']);
    });
  });
});
