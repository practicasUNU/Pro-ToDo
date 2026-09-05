import {
  createTemplateRendererService,
  TEST_ASSETS_BASE_URL,
} from '@test/factories/template-renderer.factory';

import { DEFAULT_ASSETS_BASE_URL } from './template-renderer.service';

import type {
  RenderNamespaces,
  TemplateRendererService,
} from './template-renderer.service';

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
    renderer = createTemplateRendererService();
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

  describe('6. Auditoria de marcado', () => {
    /** Atajo: la auditoria devuelve objetos, pero casi todo se afirma por par. */
    const audit = (html: string): Array<{ type: string; target: string }> =>
      renderer
        .auditPublishableMarkup(html)
        .map(({ type, target }) => ({ type, target }));

    it('6.1 deberia detectar <body>, que el modo fragmento de parse5 esconde', () => {
      // 1. Arrange & 2. Act: caso de aceptacion del requisito. Con el parser por
      //    defecto (`load(html, null, false)`) parse5 descarta `<body>` por ser
      //    invalido en un fragmento y esta asercion daria [].
      const violations = renderer.auditPublishableMarkup(
        '<body> <p>Hola</p> </body>',
      );

      // 3. Assert
      expect(violations).toEqual([
        {
          target: 'body',
          type: 'tag',
          message: 'Etiqueta <body> no permitida',
        },
      ]);
    });

    it('6.2 deberia detectar <script> y <style>', () => {
      // 1. Arrange & 2. Act
      const violations = audit('<style>p{}</style><p>ok</p><script>x</script>');

      // 3. Assert: domhandler no los etiqueta como `tag` sino con tipo propio;
      //    esto fija que la guarda de estrechamiento no los deja fuera.
      expect(violations).toEqual([
        { target: 'style', type: 'tag' },
        { target: 'script', type: 'tag' },
      ]);
    });

    it('6.3 deberia detectar <iframe> y <section>', () => {
      // 1. Arrange & 2. Act
      const violations = audit(
        '<iframe src="http://x">dentro</iframe><section><p>a</p></section>',
      );

      // 3. Assert
      expect(violations).toEqual([
        { target: 'iframe', type: 'tag' },
        { target: 'section', type: 'tag' },
      ]);
    });

    it('6.4 deberia detectar los atributos de evento con mensaje propio', () => {
      // 1. Arrange & 2. Act
      const violations = renderer.auditPublishableMarkup(
        '<img src="https://x/a.png" onerror="alert(1)" alt="x">',
      );

      // 3. Assert: solo `onerror`; `src` y `alt` estan permitidos en <img>
      expect(violations).toEqual([
        {
          target: 'onerror',
          type: 'attribute',
          message: "Atributo de evento 'onerror' no permitido",
        },
      ]);
    });

    it('6.5 deberia detectar un atributo que no es de evento (srcset)', () => {
      // 1. Arrange & 2. Act: lo que las reglas de solo tag/on*/protocolo
      //    dejarian pasar, y que el saneador si recorta.
      const violations = renderer.auditPublishableMarkup(
        '<img src="https://x/a.png" srcset="https://x/b.png 2x" alt="x">',
      );

      // 3. Assert
      expect(violations).toEqual([
        {
          target: 'srcset',
          type: 'attribute',
          message: "Atributo 'srcset' no permitido en <img>",
        },
      ]);
    });

    it('6.6 deberia detectar los pseudo-protocolos javascript: y data:', () => {
      // 1. Arrange & 2. Act
      const violations = audit(
        '<a href="javascript:alert(1)">c</a><a href="data:text/html,x">d</a>',
      );

      // 3. Assert
      expect(violations).toEqual([
        { target: 'javascript:', type: 'protocol' },
        { target: 'data:', type: 'protocol' },
      ]);
    });

    it('6.7 NO deberia inspeccionar los atributos de una etiqueta ya prohibida', () => {
      // 1. Arrange & 2. Act
      const violations = audit('<marquee onclick="x()" srcset="y">t</marquee>');

      // 3. Assert: el saneador descarta el elemento entero; senalar tambien sus
      //    atributos solo anadiria ruido sobre lo que hay que corregir.
      expect(violations).toEqual([{ target: 'marquee', type: 'tag' }]);
    });

    it('6.8 deberia normalizar el target a minusculas', () => {
      // 1. Arrange & 2. Act
      const violations = audit('<BODY><IMG SRC="x" ONERROR="y"></BODY>');

      // 3. Assert: los DOS targets salen en minusculas. El `ONERROR` anidado se
      //    senala aunque su ancestro ya este prohibido, y debe ser asi: `discard`
      //    elimina el `<body>` pero conserva sus hijos, de modo que ese atributo
      //    llegaria al articulo publicado. La guarda de 6.7 solo salta los
      //    atributos DEL PROPIO elemento descartado, no los de su descendencia.
      expect(violations).toEqual([
        { target: 'body', type: 'tag' },
        { target: 'onerror', type: 'attribute' },
      ]);
    });

    it('6.9 deberia de-duplicar infracciones repetidas conservando el orden', () => {
      // 1. Arrange & 2. Act
      const violations = audit(
        '<script>a</script><section>x</section><script>b</script>',
      );

      // 3. Assert: dos <script> son UN problema que resolver
      expect(violations).toEqual([
        { target: 'script', type: 'tag' },
        { target: 'section', type: 'tag' },
      ]);
    });

    it('6.10 NO deberia marcar los enlaces relativos ni las anclas', () => {
      // 1. Arrange & 2. Act: sin esquema no hay pseudo-protocolo
      const violations = renderer.auditPublishableMarkup(
        '<a href="/ruta/relativa">r</a><a href="#seccion">a</a><a href="mailto:a@b.com">m</a>',
      );

      // 3. Assert
      expect(violations).toEqual([]);
    });

    it('6.11 NO deberia marcar una plantilla limpia con sus marcadores', () => {
      // 1. Arrange & 2. Act: la prueba de que no hay falsos positivos
      const violations = renderer.auditPublishableMarkup(
        '<h1>{{parsed_email.clean_title}}</h1>' +
          '<p>{{llm_response.summary}}</p><br><hr>' +
          '<figure><img src="https://x/a.png" alt="f"><figcaption>Pie</figcaption></figure>' +
          '<a href="https://x" target="_blank" rel="noopener">link</a>' +
          '<time datetime="2026-01-01">hoy</time>',
      );

      // 3. Assert
      expect(violations).toEqual([]);
    });

    it('6.12 deberia coincidir con el veredicto de la sonda de dos pasadas', () => {
      // 1. Arrange: la sonda es la puerta y la auditoria el localizador; que
      //    discrepen significaria rechazar sin poder senalar, o al reves.
      const samples = [
        '<body><p>a</p></body>',
        '<img src="a.png" srcset="b.png 2x" alt="x">',
        '<a href="javascript:void(0)">c</a>',
        '<section><p>a</p></section>',
        '<h1>Hola</h1><p>Mundo</p>',
        '<a href="/relativa">r</a>',
      ];

      // 2. Act & 3. Assert
      for (const html of samples) {
        const { wasFiltered } = renderer.inspectPublishableMarkup(html);

        expect(renderer.auditPublishableMarkup(html).length > 0).toBe(
          wasFiltered,
        );
      }
    });
  });
  describe('7. Namespace sintetico _assets y rutas relativas', () => {
    /** Plantilla canonica del fixture: prefijo de entorno + ruta del contexto. */
    const IMAGE_TEMPLATE =
      '<img src="{{_assets.base_url}}/{{parsed_email.image_path}}" alt="foto" />';
    const IMAGE_VARIABLES = ['_assets.base_url', 'parsed_email.image_path'];

    it('7.1 deberia compilar {{_assets.base_url}} sin que el contexto lo aporte', () => {
      // 1. Arrange: el contexto NO trae `_assets`; lo inyecta el renderer
      const namespaces: RenderNamespaces = {
        parsed_email: { image_path: '2026/09/laboratorio.jpg' },
      };

      // 2. Act
      const outcome = renderer.renderStrict(
        IMAGE_TEMPLATE,
        IMAGE_VARIABLES,
        namespaces,
      );

      // 3. Assert
      expect(outcome).toEqual({
        markup: `<img src="${TEST_ASSETS_BASE_URL}/2026/09/laboratorio.jpg" alt="foto" />`,
      });
    });

    it('7.2 deberia recortar la barra inicial de image_path para no duplicarla', () => {
      // 1. Arrange
      const namespaces: RenderNamespaces = {
        parsed_email: { image_path: '/2026/09/laboratorio.jpg' },
      };

      // 2. Act
      const outcome = renderer.renderStrict(
        IMAGE_TEMPLATE,
        IMAGE_VARIABLES,
        namespaces,
      );

      // 3. Assert: la URL canonica no debe llevar `//` tras el prefijo
      expect(outcome).toEqual({
        markup: `<img src="${TEST_ASSETS_BASE_URL}/2026/09/laboratorio.jpg" alt="foto" />`,
      });
      expect('markup' in outcome && outcome.markup).not.toContain('uploads//');
    });

    it('7.3 deberia recortar tambien varias barras iniciales', () => {
      // 1. Arrange & 2. Act
      const outcome = renderer.renderStrict(IMAGE_TEMPLATE, IMAGE_VARIABLES, {
        parsed_email: { image_path: '///2026/09/laboratorio.jpg' },
      });

      // 3. Assert
      expect(outcome).toEqual({
        markup: `<img src="${TEST_ASSETS_BASE_URL}/2026/09/laboratorio.jpg" alt="foto" />`,
      });
    });

    it('7.4 deberia recortar la barra final del prefijo declarado en el entorno', () => {
      // 1. Arrange: `ASSETS_BASE_URL` con barra sobrante, error tipico de .env
      const trailingRenderer = createTemplateRendererService(
        `${TEST_ASSETS_BASE_URL}///`,
      );

      // 2. Act
      const outcome = trailingRenderer.renderStrict(
        IMAGE_TEMPLATE,
        IMAGE_VARIABLES,
        { parsed_email: { image_path: '/2026/09/laboratorio.jpg' } },
      );

      // 3. Assert
      expect(outcome).toEqual({
        markup: `<img src="${TEST_ASSETS_BASE_URL}/2026/09/laboratorio.jpg" alt="foto" />`,
      });
    });

    it('7.5 deberia usar DEFAULT_ASSETS_BASE_URL si la variable no esta declarada', () => {
      // 1. Arrange
      const fallbackRenderer = createTemplateRendererService(null);

      // 2. Act
      const outcome = fallbackRenderer.renderStrict(
        '<p>{{_assets.base_url}}</p>',
        ['_assets.base_url'],
        {},
      );

      // 3. Assert
      expect(outcome).toEqual({
        markup: `<p>${DEFAULT_ASSETS_BASE_URL}</p>`,
      });
    });

    it('7.6 NO deberia tocar los campos que no son rutas de asset', () => {
      // 1. Arrange: un cuerpo que arranca con "/" es texto legitimo, no ruta
      const namespaces: RenderNamespaces = {
        parsed_email: { clean_body: '/no soy una ruta', source_url: '/a/b' },
      };

      // 2. Act
      const outcome = renderer.renderStrict(
        '<p>{{parsed_email.clean_body}}</p><span>{{parsed_email.source_url}}</span>',
        ['parsed_email.clean_body', 'parsed_email.source_url'],
        namespaces,
      );

      // 3. Assert
      expect(outcome).toEqual({
        markup: '<p>/no soy una ruta</p><span>/a/b</span>',
      });
    });

    it('7.7 deberia ignorar un _assets que venga del contexto', () => {
      // 1. Arrange: un nodo no puede suplantar el prefijo escribiendo `_assets`
      const namespaces: RenderNamespaces = {
        _assets: { base_url: 'https://atacante.example' },
      };

      // 2. Act
      const outcome = renderer.renderStrict(
        '<p>{{_assets.base_url}}</p>',
        ['_assets.base_url'],
        namespaces,
      );

      // 3. Assert
      expect(outcome).toEqual({ markup: `<p>${TEST_ASSETS_BASE_URL}</p>` });
    });
  });
});
