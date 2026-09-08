// Alias obligatorio: `html` es el nombre que exporta js-beautify para su
// formateador de HTML, y en el editor lo ocupa el modo de lenguaje de CodeMirror.
import { html as beautifyHtml } from 'js-beautify';

// Helper puro (frontend-architecture.md §2.1): transforma un dato en otro, sin
// estado ni I/O. Vive aqui y no dentro de `TemplateCodeEditor.vue` porque la
// configuracion de abajo sostiene una invariante del backend, y desde
// `src/utils/` si se puede probar de forma aislada. El componente se queda solo
// con lo que es suyo: despachar la transaccion de CodeMirror.

/**
 * Opciones de `js-beautify` para las plantillas del gestor.
 *
 * Dos de ellas NO son preferencias de estilo, son requisitos:
 *
 * - `wrap_line_length: 0` desactiva el corte de linea por ancho. Con un limite
 *   activo, una etiqueta con varios `{{ns.campo}}` se partiria por cualquier
 *   punto, y un salto DENTRO de la ruta del marcador lo deja fuera de
 *   `TEMPLATE_VARIABLE_PATTERN`: el backend lo tomaria por marcador no
 *   interpretable y rechazaria la plantilla con un 400.
 * - `end_with_newline: false` evita que cada pasada anada una linea al final y
 *   el documento crezca solo por pulsar el boton.
 *
 * `indent_inner_html: false` deja `<head>` y `<body>` sin sangrar, que es lo
 * correcto aqui: una plantilla compone el CUERPO de una noticia, no la pagina
 * que la envuelve, y el saneador del backend descarta esas etiquetas.
 */
const BEAUTIFY_OPTIONS = {
  indent_size: 2,
  indent_char: ' ',
  max_preserve_newlines: 1,
  preserve_newlines: true,
  end_with_newline: false,
  wrap_line_length: 0,
  indent_inner_html: false,
} as const;

/**
 * Reindenta el HTML de una plantilla sin tocar sus marcadores interpolables.
 *
 * @param rawHtml Contenido del editor, tal y como lo escribio el autor.
 * @returns El mismo HTML reindentado. Es idempotente: aplicarlo dos veces
 *          devuelve exactamente lo mismo, y de eso depende la guarda del editor
 *          que evita apilar un paso de historial vacio.
 */
export const formatTemplateHtml = (rawHtml: string): string =>
  beautifyHtml(rawHtml, BEAUTIFY_OPTIONS);
