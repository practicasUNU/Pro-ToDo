import { describe, expect, it } from 'vitest';

import { formatTemplateHtml } from './html-formatter';

/**
 * Gramatica del marcador interpolable, copiada de `TEMPLATE_VARIABLE_PATTERN`
 * (backend, `templates.service.ts`).
 *
 * Es la referencia que importa: el formateo solo es correcto si TODO marcador
 * sigue casando con ella despues de pasar por el formateador. Un salto de linea
 * dentro de la ruta lo dejaria fuera, y el backend rechazaria la plantilla.
 */
const BACKEND_VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)((?:\.(?:[a-zA-Z0-9_]+|\[\d+\]))+)\s*\}\}/g;

/** Cualquier marcador que sobreviva a la extraccion: sintaxis no reconocida. */
const RESIDUAL_MARKER_PATTERN = /\{\{[\s\S]*?\}\}/;

/** Rutas que el backend extraeria del HTML, en orden de aparicion. */
const extractVariables = (html: string): string[] =>
  [...html.matchAll(BACKEND_VARIABLE_PATTERN)].map(
    ([, namespace, nestedPath]) => `${namespace}${nestedPath}`,
  );

/** Lo que quedaria sin interpretar tras consumir los marcadores validos. */
const residualMarker = (html: string): string | undefined => {
  const [marker] = RESIDUAL_MARKER_PATTERN.exec(html.replace(BACKEND_VARIABLE_PATTERN, '')) ?? [];

  return marker;
};

describe('formatTemplateHtml', () => {
  describe('1. Reindentado', () => {
    it('1.1 deberia desplegar el HTML de una sola linea', () => {
      // 1. Arrange
      const raw = '<div><h1>Titular</h1><p>Cuerpo</p></div>';

      // 2. Act
      const formatted = formatTemplateHtml(raw);

      // 3. Assert
      expect(formatted).toBe(
        ['<div>', '  <h1>Titular</h1>', '  <p>Cuerpo</p>', '</div>'].join('\n'),
      );
    });

    it('1.2 deberia sangrar dos espacios por nivel de anidamiento', () => {
      // 1. Arrange & 2. Act
      const formatted = formatTemplateHtml('<div><ul><li>x</li></ul></div>');

      // 3. Assert
      expect(formatted).toBe(['<div>', '  <ul>', '    <li>x</li>', '  </ul>', '</div>'].join('\n'));
    });

    it('1.3 NO deberia separar de su linea las etiquetas en linea', () => {
      // 1. Arrange & 2. Act: partir un `<span>` o un `<strong>` meteria espacio
      // en blanco donde no lo habia, y eso SI se ve en el articulo publicado
      const formatted = formatTemplateHtml('<p>Hola <strong>mundo</strong>!</p>');

      // 3. Assert
      expect(formatted).toBe('<p>Hola <strong>mundo</strong>!</p>');
    });

    it('1.4 NO deberia anadir una linea al final', () => {
      // 1. Arrange & 2. Act: `end_with_newline: false` evita que el documento
      // crezca solo por pulsar el boton repetidamente
      const formatted = formatTemplateHtml('<p>x</p>');

      // 3. Assert
      expect(formatted.endsWith('\n')).toBe(false);
    });

    it('1.5 deberia ser idempotente', () => {
      // 1. Arrange: de esto depende la guarda del editor que evita apilar un
      // paso de historial vacio
      const raw = '<div><h1>{{parsed_email.clean_title}}</h1><p>Cuerpo</p></div>';

      // 2. Act
      const once = formatTemplateHtml(raw);
      const twice = formatTemplateHtml(once);

      // 3. Assert
      expect(twice).toBe(once);
    });
  });

  describe('2. Los marcadores sobreviven intactos (Poka-Yoke)', () => {
    it('2.1 deberia conservar los marcadores del HTML de una sola linea', () => {
      // 1. Arrange: el caso que motiva el boton — plantilla pegada sin formato
      const raw =
        '<div><h1>{{parsed_email.clean_title}}</h1><p>{{llm_response.summary}}</p>' +
        '<table><tr><td>{{llm_response.articles.[0].title}}</td></tr></table></div>';

      // 2. Act
      const formatted = formatTemplateHtml(raw);

      // 3. Assert
      expect(extractVariables(formatted)).toEqual(extractVariables(raw));
      expect(residualMarker(formatted)).toBeUndefined();
    });

    it('2.2 NO deberia partir una linea larga con varios marcadores', () => {
      // 1. Arrange: con un `wrap_line_length` activo, el corte caeria dentro de
      // alguna ruta y el backend devolveria un 400 por marcador no interpretable
      const raw =
        '<p>{{parsed_email.clean_title}} - {{parsed_email.description}} - ' +
        '{{llm_response.summary}} - {{scraped_web.headline}} - ' +
        '{{validated_drupal_json.body}} - {{raw_email.subject}}</p>';

      // 2. Act
      const formatted = formatTemplateHtml(raw);

      // 3. Assert
      expect(extractVariables(formatted)).toHaveLength(6);
      expect(extractVariables(formatted)).toEqual(extractVariables(raw));
      expect(residualMarker(formatted)).toBeUndefined();
    });

    it('2.3 deberia conservar los marcadores dentro de atributos', () => {
      // 1. Arrange: la etiqueta del fixture del Camino B, con el namespace
      // sintetico `_assets` y una ruta relativa concatenada
      const raw =
        '<img src="{{_assets.base_url}}/{{parsed_email.image_path}}" ' +
        'alt="{{parsed_email.clean_title}}" title="{{parsed_email.description}}" ' +
        'width="600" height="400" class="hero destacada" />';

      // 2. Act
      const formatted = formatTemplateHtml(raw);

      // 3. Assert
      expect(extractVariables(formatted)).toEqual([
        '_assets.base_url',
        'parsed_email.image_path',
        'parsed_email.clean_title',
        'parsed_email.description',
      ]);
      expect(formatted).toContain('src="{{_assets.base_url}}/{{parsed_email.image_path}}"');
    });

    it('2.4 deberia respetar los espacios internos del marcador', () => {
      // 1. Arrange & 2. Act: `{{ ns.campo }}` es sintaxis valida para el backend
      const formatted = formatTemplateHtml('<div><h1>{{ parsed_email.clean_title }}</h1></div>');

      // 3. Assert
      expect(extractVariables(formatted)).toEqual(['parsed_email.clean_title']);
      expect(residualMarker(formatted)).toBeUndefined();
    });

    it('2.5 deberia conservar el HTML del fixture del Camino B sin tocar sus rutas', () => {
      // 1. Arrange
      const raw = [
        '<h1>{{parsed_email.clean_title}}</h1>',
        '<p>{{parsed_email.description}}</p>',
        '<img src="{{_assets.base_url}}/{{parsed_email.image_path}}" alt="{{parsed_email.clean_title}}" width="600" height="400" />',
        '<div class="body">{{parsed_email.clean_body}}</div>',
      ].join('\n');

      // 2. Act
      const formatted = formatTemplateHtml(raw);

      // 3. Assert
      expect(extractVariables(formatted)).toEqual(extractVariables(raw));
      expect(residualMarker(formatted)).toBeUndefined();
    });
  });
});
