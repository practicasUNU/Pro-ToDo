/**
 * Entidades de los cinco caracteres con significado dentro de un documento HTML.
 *
 * `&` va PRIMERO en el orden de sustitucion y por eso se resuelve con un solo
 * recorrido: escapar `<` antes que `&` convertiria un `<` en `&lt;` y el `&`
 * recien introducido volveria a escaparse a `&amp;lt;`, que el cliente de correo
 * pinta literalmente como "&lt;".
 */
const HTML_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const ESCAPABLE_PATTERN = /[&<>"']/g;

/**
 * Neutraliza el marcado de un valor que se va a incrustar en una plantilla HTML.
 *
 * Es OBLIGATORIO sobre todo dato dinamico de la carta de alerta, sin excepcion,
 * y el motivo es que buena parte de ese dato viene del correo ENTRANTE: el
 * `error_message` del parser cita el asunto del mensaje, y `partial_data` lleva
 * el inventario de adjuntos con sus nombres de archivo. Los escribe quien envia
 * el correo al buzon del flujo, que es cualquiera. Sin escapar, un remitente que
 * ponga `<img src=x onerror=...>` en el nombre de un adjunto inyecta marcado en
 * el buzon del responsable de guardia.
 *
 * NO se usa `sanitize-html`, que el proyecto ya tiene, y no es por ahorrar una
 * dependencia: esa libreria RETIRA etiquetas de un documento, mientras que aqui
 * hace falta CONSERVAR el texto tal cual y volverlo inofensivo. Con
 * `allowedTags: []` ademas re-escapa lo que ya era texto plano —un "AT&T" sale
 * como "AT&amp;T"—, que es justo el defecto documentado en
 * `article-extractor.util.ts`.
 *
 * Tampoco se apoya en `Handlebars.escapeExpression`: la carta no es una
 * plantilla compilada, y arrastrar el motor entero para escapar cinco
 * caracteres ataria este util a una dependencia que puede desaparecer.
 *
 * Las comillas simples se escapan aunque la plantilla use dobles en sus
 * atributos: el valor se compone con plantillas de cadena, y basta un cambio de
 * comilla en el futuro para que la omision se convierta en un escape de atributo.
 */
export const escapeHtml = (value: string): string =>
  value.replace(
    ESCAPABLE_PATTERN,
    (character) => HTML_ENTITIES[character] ?? character,
  );
