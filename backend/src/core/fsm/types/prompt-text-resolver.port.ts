/**
 * Puerto para leer el texto de un prompt guardado desde el nucleo.
 *
 * POR QUE UN PUERTO Y NO EL SERVICIO. Los prompts viven en
 * `@modules/ai-prompt-templates`, y el validador de topologia que los necesita
 * vive en `@core`. Depender aqui del servicio concreto invertiria la direccion
 * de las dependencias; declarar la forma que `@core` necesita y dejar que el
 * modulo la implemente la mantiene apuntando hacia dentro.
 *
 * DEVUELVE TEXTO, NO NAMESPACES, y es deliberado. El analizador
 * (`extractNamespaceRoots`) ya vive en `@core`, junto al patron que el motor usa
 * para interpolar de verdad. Si el puerto devolviera namespaces habria dos
 * analizadores, y divergirian a la primera correccion de la expresion regular —
 * el mismo motivo por el que `AiPromptTemplatesService.toDetail` reutiliza el de
 * la FSM en vez de reimplementarlo.
 */

/** Como un nodo cita un prompt guardado: por id o por codigo inmutable. */
export interface PromptReference {
  readonly kind: 'id' | 'code';
  readonly value: string;
}

/**
 * Token de inyeccion.
 *
 * `Symbol` y no una cadena: no hay forma de colisionar con otro proveedor por
 * accidente, y el compilador obliga a importar la constante para pedirlo.
 */
export const PROMPT_TEXT_RESOLVER = Symbol('PROMPT_TEXT_RESOLVER');

/** Clave de una referencia dentro del mapa que devuelve el puerto. */
export const promptReferenceKey = ({ kind, value }: PromptReference): string =>
  `${kind}:${value}`;

export interface PromptTextResolverPort {
  /**
   * Texto de cada prompt citado, indexado por `promptReferenceKey`.
   *
   * Recibe TODAS las referencias de un esquema de una vez para que el adaptador
   * pueda resolverlas en una sola consulta: validar un flujo no debe costar una
   * consulta por nodo.
   *
   * Una referencia que no resuelve se OMITE del mapa en vez de lanzar. Que un
   * `templatePromptId` apunte a un prompt borrado es un problema distinto —y lo
   * diagnostica la estrategia en ejecucion con `ERR_LLM_PROMPT_UNRESOLVED`—;
   * convertirlo aqui en un fallo de dependencias mandaria al operador a
   * reordenar un flujo cuyo orden esta bien.
   */
  resolvePromptTexts(
    references: readonly PromptReference[],
  ): Promise<ReadonlyMap<string, string>>;
}
