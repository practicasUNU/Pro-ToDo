import { TemplateRendererService } from './template-renderer.service';

import type { RenderNamespaces } from './template-renderer.service';

/** Contexto tipico de una ejecucion a mitad de pipeline. */
const buildNamespaces = (): RenderNamespaces => ({
  parsed_email: { clean_title: 'Innovacion en Madrid' },
  llm_response: {
    summary: 'Resumen estructurado.',
    articles: [{ title: 'Primer titular' }],
  },
});

describe('TemplateRendererService', () => {
  let renderer: TemplateRendererService;

  beforeEach(() => {
    renderer = new TemplateRendererService();
  });

  describe('1. Render exitoso', () => {
    it('1.1 deberia sustituir las variables por su valor', () => {
      // 1. Arrange & 2. Act
      const outcome = renderer.renderStrict(
        '<h1>{{parsed_email.clean_title}}</h1>',
        ['parsed_email.clean_title'],
        buildNamespaces(),
      );

      // 3. Assert
      expect(outcome).toEqual({ markup: '<h1>Innovacion en Madrid</h1>' });
    });

    it('1.2 deberia resolver rutas anidadas con indice', () => {
      // 1. Arrange & 2. Act
      const outcome = renderer.renderStrict(
        '<h2>{{llm_response.articles.[0].title}}</h2>',
        ['llm_response.articles.0.title'],
        buildNamespaces(),
      );

      // 3. Assert
      expect(outcome).toEqual({ markup: '<h2>Primer titular</h2>' });
    });

    it('1.3 deberia escapar el HTML presente en un valor del contexto', () => {
      // 1. Arrange
      const namespaces: RenderNamespaces = {
        parsed_email: { clean_title: '<img src=x onerror=alert(1)>' },
      };

      // 2. Act
      const outcome = renderer.renderStrict(
        '<h1>{{parsed_email.clean_title}}</h1>',
        ['parsed_email.clean_title'],
        namespaces,
      );

      // 3. Assert: el escapado por defecto de {{ }} es la razon por la que el
      // gestor prohibe el triple-stash al guardar
      expect(outcome).toHaveProperty('markup');
      expect('markup' in outcome && outcome.markup).not.toContain('<img');
    });

    it('1.4 deberia devolver intacto un HTML sin variables', () => {
      // 1. Arrange & 2. Act
      const outcome = renderer.renderStrict('<p>Texto fijo</p>', [], {});

      // 3. Assert
      expect(outcome).toEqual({ markup: '<p>Texto fijo</p>' });
    });
  });

  describe('2. Variables ausentes', () => {
    it('2.1 deberia reportar TODAS las rutas que faltan, no solo la primera', () => {
      // 1. Arrange & 2. Act
      const outcome = renderer.renderStrict(
        '<p>{{scraped_web.headline}}{{raw_email.body}}</p>',
        ['scraped_web.headline', 'raw_email.body'],
        buildNamespaces(),
      );

      // 3. Assert: Handlebars estricto solo delataria la primera; el
      // pre-chequeo existe para que el operador arregle el flujo de una vez
      expect(outcome).toEqual({
        missingFields: ['scraped_web.headline', 'raw_email.body'],
      });
    });

    it('2.2 deberia detectar un indice fuera de rango', () => {
      // 1. Arrange & 2. Act
      const outcome = renderer.renderStrict(
        '<h2>{{llm_response.articles.[5].title}}</h2>',
        ['llm_response.articles.5.title'],
        buildNamespaces(),
      );

      // 3. Assert
      expect(outcome).toEqual({
        missingFields: ['llm_response.articles.5.title'],
      });
    });

    it('2.3 deberia fallar por modo estricto si la ruta no venia declarada', () => {
      // 1. Arrange & 2. Act: sin requiredVariables no hay pre-chequeo, y el
      // corte lo pone `strict: true` de Handlebars
      const outcome = renderer.renderStrict(
        '<p>{{scraped_web.headline}}</p>',
        [],
        buildNamespaces(),
      );

      // 3. Assert
      expect(outcome).toHaveProperty('failure');
    });
  });

  describe('3. Fallo de compilacion', () => {
    it('3.1 deberia devolver failure con stackTrace ante sintaxis rota', () => {
      // 1. Arrange & 2. Act
      const outcome = renderer.renderStrict(
        '{{#if algo}}<p>sin cerrar</p>',
        [],
        {},
      );

      // 3. Assert
      expect(outcome).toHaveProperty('failure');
      expect('failure' in outcome && outcome.stackTrace).toBeDefined();
    });

    it('3.2 no deberia lanzar nunca: el fallo viaja en el valor de retorno', () => {
      // 1. Arrange & 2. Act & 3. Assert
      expect(() => renderer.renderStrict('{{/each}}', [], {})).not.toThrow();
    });
  });

  describe('4. Sanitizacion XSS', () => {
    it('4.1 deberia purgar un <script> junto con su contenido', () => {
      // 1. Arrange & 2. Act
      const outcome = renderer.renderStrict(
        '<p>ok</p><script>alert(1)</script>',
        [],
        {},
      );

      // 3. Assert
      expect(outcome).toEqual({ markup: '<p>ok</p>' });
    });

    it('4.2 deberia purgar un <style> junto con su contenido', () => {
      // 1. Arrange & 2. Act
      const outcome = renderer.renderStrict(
        '<style>body{color:red}</style><p>ok</p>',
        [],
        {},
      );

      // 3. Assert
      expect(outcome).toEqual({ markup: '<p>ok</p>' });
    });

    it('4.3 deberia purgar un <iframe> junto con su contenido', () => {
      // 1. Arrange & 2. Act
      const outcome = renderer.renderStrict(
        '<iframe src="http://evil.example">texto interno</iframe><p>ok</p>',
        [],
        {},
      );

      // 3. Assert: sin `iframe` en `nonTextTags`, "texto interno" sobreviviria
      // suelto en el articulo. Esta prueba es la que fija esa configuracion.
      expect(outcome).toEqual({ markup: '<p>ok</p>' });
    });

    it('4.4 deberia eliminar el manejador onerror conservando la imagen', () => {
      // 1. Arrange & 2. Act
      const outcome = renderer.renderStrict(
        '<img src="x" onerror="alert(1)">',
        [],
        {},
      );

      // 3. Assert
      expect(outcome).toEqual({ markup: '<img src="x" />' });
    });

    it('4.5 deberia eliminar el manejador onclick conservando el elemento', () => {
      // 1. Arrange & 2. Act
      const outcome = renderer.renderStrict(
        '<div onclick="alert(1)">texto</div>',
        [],
        {},
      );

      // 3. Assert
      expect(outcome).toEqual({ markup: '<div>texto</div>' });
    });

    it('4.6 deberia descartar un href con protocolo javascript:', () => {
      // 1. Arrange & 2. Act
      const outcome = renderer.renderStrict(
        '<a href="javascript:alert(1)">click</a>',
        [],
        {},
      );

      // 3. Assert: el enlace sobrevive como texto, sin destino ejecutable
      expect(outcome).toEqual({ markup: '<a>click</a>' });
    });

    it('4.7 deberia forzar rel="noopener noreferrer" en los enlaces target=_blank', () => {
      // 1. Arrange & 2. Act
      const outcome = renderer.renderStrict(
        '<a href="https://unuware.com" target="_blank">ir</a>',
        [],
        {},
      );

      // 3. Assert: sin noopener, el destino puede redirigir la pestana de origen
      expect(outcome).toEqual({
        markup:
          '<a href="https://unuware.com" target="_blank" rel="noopener noreferrer">ir</a>',
      });
    });

    it('4.8 deberia conservar intactas las etiquetas de la lista blanca', () => {
      // 1. Arrange
      const html =
        '<h1>Titular</h1><figure><img src="https://x/a.png" alt="foto" />' +
        '<figcaption>Pie</figcaption></figure><p class="cuerpo">Texto</p>';

      // 2. Act
      const outcome = renderer.renderStrict(html, [], {});

      // 3. Assert
      expect(outcome).toEqual({ markup: html });
    });

    it('4.9 deberia sanear el markup DESPUES de interpolar, no antes', () => {
      // 1. Arrange: la plantilla es limpia; lo peligroso entra por el contexto
      const namespaces: RenderNamespaces = {
        llm_response: { summary: '<img src=x onerror=alert(1)>' },
      };

      // 2. Act
      const outcome = renderer.renderStrict(
        '<p>{{llm_response.summary}}</p>',
        ['llm_response.summary'],
        namespaces,
      );

      // 3. Assert: lo que importa es que NO se forme un elemento, no que la
      // cadena "onerror=" no aparezca. Handlebars escapa el `=` a `&#x3D;` y el
      // saneador lo re-serializa como `=` al normalizar entidades, asi que ese
      // texto sigue ahi — pero dentro de un nodo de TEXTO, con el `<` como
      // `&lt;`, de modo que el navegador nunca construye la etiqueta.
      expect(outcome).toEqual({
        markup: '<p>&lt;img src=x onerror=alert(1)&gt;</p>',
      });
    });

    it('4.10 deberia descartar etiquetas de estructura de pagina', () => {
      // 1. Arrange & 2. Act: una plantilla compone el CUERPO de una noticia
      const outcome = renderer.renderStrict(
        '<section><p>ok</p></section>',
        [],
        {},
      );

      // 3. Assert: `discard` quita la etiqueta pero conserva su contenido
      expect(outcome).toEqual({ markup: '<p>ok</p>' });
    });
  });

  describe('5. inspectPublishableMarkup', () => {
    it('5.1 deberia marcar como filtrado el markup con un <script>', () => {
      // 1. Arrange & 2. Act
      const result = renderer.inspectPublishableMarkup(
        '<p>ok</p><script>alert(1)</script>',
      );

      // 3. Assert
      expect(result.wasFiltered).toBe(true);
      expect(result.sanitized).toBe('<p>ok</p>');
    });

    it('5.2 deberia marcar como filtrado un atributo de evento', () => {
      // 1. Arrange & 2. Act
      const result = renderer.inspectPublishableMarkup(
        '<img src="x" onerror="alert(1)">',
      );

      // 3. Assert
      expect(result.wasFiltered).toBe(true);
    });

    it('5.3 NO deberia marcar como filtrada una normalizacion del parser', () => {
      // 1. Arrange & 2. Act: `<br>` sale como `<br />` en AMBAS pasadas
      const result = renderer.inspectPublishableMarkup('<p>hola<br>mundo</p>');

      // 3. Assert: comparar contra el HTML crudo daria aqui un falso positivo;
      // comparar dos pasadas del mismo parser, no.
      expect(result.wasFiltered).toBe(false);
      expect(result.sanitized).toBe('<p>hola<br />mundo</p>');
    });

    it('5.4 NO deberia marcar como filtrado un target=_blank legitimo', () => {
      // 1. Arrange & 2. Act
      const result = renderer.inspectPublishableMarkup(
        '<a href="https://unuware.com" target="_blank">ir</a>',
      );

      // 3. Assert: el `rel` es una ADICION de transformTags, no una eliminacion.
      // La sonda aplica la misma transformacion para no confundirlas.
      expect(result.wasFiltered).toBe(false);
    });

    it('5.5 NO deberia marcar como filtrado el markup permitido', () => {
      // 1. Arrange & 2. Act
      const result = renderer.inspectPublishableMarkup(
        '<figure><img src="https://x/a.png" alt="f"><figcaption>Pie</figcaption></figure>',
      );

      // 3. Assert
      expect(result.wasFiltered).toBe(false);
    });
  });
});
