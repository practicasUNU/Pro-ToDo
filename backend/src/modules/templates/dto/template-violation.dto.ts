/**
 * Naturaleza de la construccion rechazada.
 *
 * Los tres primeros nacen de la auditoria de markup; `variable` cubre los fallos
 * de interpolacion (namespace fuera de la lista blanca, sintaxis prohibida o
 * marcador no interpretable), que hasta ahora solo viajaban como texto.
 */
export type ViolationType = 'tag' | 'attribute' | 'protocol' | 'variable';

/**
 * Infraccion localizable dentro del HTML de una plantilla.
 *
 * Es un contrato de SALIDA —viaja dentro del cuerpo de un `BadRequestException`,
 * nunca entra por una peticion—, de ahi que sea una interfaz sin decoradores de
 * `class-validator`, a diferencia del resto de DTOs de esta carpeta.
 *
 * ## Invariante de `target`
 *
 * Es lo unico que permite al editor pasar de "algo esta mal" a subrayar el sitio
 * exacto, y su forma DEPENDE del tipo:
 *
 * - `tag`, `attribute`, `protocol`: identificador ya normalizado a minusculas
 *   (`body`, `onerror`, `javascript:`). El editor lo busca con un patron
 *   estructural e insensible a mayusculas, porque en el documento puede aparecer
 *   como `<BODY>` o `onError=`.
 * - `variable`: subcadena LITERAL y verbatim del documento, espacios incluidos
 *   (`{{ bad_ns.titulo }}`, `{{{`, `{{titulo}}`). Se busca tal cual.
 *
 * Mezclar ambas formas obligaria al frontend a adivinar como localizar cada una.
 */
export interface TemplateViolation {
  /** Texto a localizar en el documento; ver la invariante de arriba. */
  readonly target: string;
  readonly type: ViolationType;
  /** Explicacion en espanol, lista para el tooltip del editor. */
  readonly message: string;
}
