// Helper puro (frontend-architecture.md §2.1): transforma un dato en otro, sin
// estado ni I/O. Vive aqui y no dentro del store del ESCUDO_POST_IA porque el
// parseo no depende de ningun nodo —es "dado este HTML, que ranuras tiene"— y
// desde `src/utils/` si se puede probar de forma aislada. El store se queda con
// lo que es suyo: decidir cuales de esas ranuras entran en la configuracion.

/**
 * Etiquetas que delimitan una ranura estructural de una plantilla.
 *
 * Lista CERRADA y corta a proposito. No se ofrecen `div`, `span` ni `p`: una
 * plantilla tiene decenas de cada uno y sugerirlos ahogaria las dos o tres que
 * de verdad importan. Las que estan aqui marcan un hueco que el redactor tiene
 * que rellenar (titulares) o un bloque cuya desaparicion el escudo debe
 * detectar (tabla, figura).
 */
const STRUCTURAL_TAGS: readonly string[] = ['h1', 'h2', 'h3', 'table', 'figure'];

/**
 * Fragmentos de clase con semantica de contenido.
 *
 * Se busca por SUBCADENA y no por igualdad porque las plantillas reales de
 * Madrid+D nombran sus ranuras con sufijos (`titular-noticia`, `resumen_corto`),
 * y exigir el nombre exacto no encontraria ninguna. Se incluyen las formas en
 * castellano y en ingles: el gestor de plantillas no impone idioma.
 */
const SEMANTIC_CLASS_FRAGMENTS: readonly string[] = [
  'titul',
  'title',
  'resumen',
  'summary',
  'body',
  'cuerpo',
  'content',
  'entry',
];

/**
 * Tope de longitud de un selector, replicado de `MAX_SELECTOR_LENGTH` del DTO.
 *
 * Se declara aqui y no se importa de `post-ia-sanitizer.types` para que este
 * helper no dependa de un nodo concreto: lo que hace vale para cualquiera que
 * necesite leer ranuras de un HTML. Un candidato mas largo se DESCARTA en vez
 * de recortarse, porque un selector truncado no casa con nada y pareceria
 * valido.
 */
const MAX_CANDIDATE_LENGTH = 120;

/**
 * Selectores CSS candidatos a ranura estructural dentro de un HTML.
 *
 * El orden importa: primero las etiquetas, que son las ranuras que casi
 * cualquier plantilla tiene, y despues las clases en orden de aparicion en el
 * documento, que es el orden en que el operador las leeria al abrirlo. El
 * autocompletado corta por la cabeza, asi que lo primero debe ser lo mas
 * probable.
 *
 * Devuelve `[]` —nunca lanza— ante un HTML vacio, malformado o sin ranuras
 * reconocibles: para el consumidor eso significa "no hay nada que sugerir
 * todavia", que es indistinguible de "aun no se ha elegido plantilla" y no
 * deberia tratarse como un error.
 */
export const extractStructuralSelectors = (html: string): string[] => {
  // Guarda de entorno: `DOMParser` no existe en Node, y este modulo lo arrastra
  // un store que tambien se evalua en el build de SSR y en los specs que no
  // declaran DOM. Sin ella, importar el store bastaria para reventar.
  if (typeof DOMParser === 'undefined' || html.trim() === '') return [];

  const document = new DOMParser().parseFromString(html, 'text/html');
  const candidates: string[] = [];

  STRUCTURAL_TAGS.forEach((tag) => {
    if (document.querySelector(tag) !== null) candidates.push(tag);
  });

  document.querySelectorAll('[class]').forEach((element) => {
    element.classList.forEach((className) => {
      const normalized = className.toLowerCase();
      const isSemantic = SEMANTIC_CLASS_FRAGMENTS.some((fragment) => normalized.includes(fragment));

      if (isSemantic) candidates.push(`.${className}`);
    });
  });

  // El deduplicado va al final y no por rama: una misma clase aparece en varios
  // elementos, y una etiqueta puede coincidir con el nombre de una clase.
  return [...new Set(candidates)].filter((candidate) => candidate.length <= MAX_CANDIDATE_LENGTH);
};
