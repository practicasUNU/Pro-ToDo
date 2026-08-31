/**
 * Patron de variable interpolable, con espacios opcionales dentro de las llaves.
 *
 * Gramatica soportada: un namespace raiz seguido de al menos un segmento, que
 * puede ser una propiedad (`.campo`) o un indice de arreglo (`[0]`), encadenados
 * sin limite:
 *
 *   {{ parsed_email.subject }}
 *   {{ parsed_email.headers.routing.ip }}
 *   {{ parsed_email.extracted_urls[0] }}
 *   {{ llm_response.articles[1].title }}
 *
 * Los identificadores se limitan a `[a-zA-Z0-9_]`, el mismo juego de caracteres
 * que `OUTPUT_NAMESPACE_PATTERN` impone a los namespaces en
 * `pipeline-schema.types.ts`: un namespace con guiones nunca podria resolverse
 * desde una plantilla, y por eso el DTO lo prohibe de entrada.
 *
 * Exigir al menos un segmento deja fuera `{{ parsed_email }}` a proposito: un
 * namespace entero no es un valor interpolable.
 */
const INTERPOLATION_PATTERN =
  /\{\{\s*([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+|\[\d+\])+)\s*\}\}/g;

/** Normaliza `urls[0]` a `urls.0`: una sola gramatica que recorrer. */
const BRACKET_INDEX_PATTERN = /\[(\d+)\]/g;

/**
 * Claves que abren la cadena de prototipos y jamas se navegan.
 *
 * Sin este filtro, una plantilla con `{{ ns.dato.__proto__.polluted }}` podria
 * leer (y en otras implementaciones, escribir) sobre `Object.prototype`. El
 * corte se refuerza con `Object.hasOwn` en cada salto, que cierra ademas el
 * resto de la cadena heredada (`toString`, `valueOf`, `hasOwnProperty`...).
 */
const BLOCKED_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/** Falta una variable que una plantilla da por presente en el contexto. */
export class MissingContextVariableException extends Error {
  constructor(public readonly variable: string) {
    super(
      `La variable "${variable}" no existe en el contexto o su valor es nulo.`,
    );
    this.name = 'MissingContextVariableException';
  }
}

/**
 * Resuelve una ruta compuesta contra los namespaces acumulados.
 *
 * Funcion PURA: no lee ni escribe estado, asi que es testeable al margen de la
 * clase y reutilizable por el nodo MAPEADOR_PLANTILLA cuando llegue. No hay
 * `eval` ni parser de expresiones: solo troceado de cadena y navegacion por
 * reduccion, tal y como exige `security-and-scope.md` §3.
 *
 * @param namespaces Mapa acumulado del contexto.
 * @param rawPath Ruta tal y como aparece en la plantilla (`urls[0].id`).
 * @returns El valor resuelto, garantizado no nulo.
 * @throws MissingContextVariableException Si la ruta no resuelve o vale nulo.
 */
export const resolvePath = (
  namespaces: Record<string, Record<string, unknown>>,
  rawPath: string,
): unknown => {
  // 1. Normalizacion: los corchetes pasan a puntos y queda una sola gramatica.
  const [namespaceKey, ...nestedKeys] = rawPath
    .replace(BRACKET_INDEX_PATTERN, '.$1')
    .split('.');

  // 2. Guarda: sin namespace raiz no hay nada que navegar.
  const root = namespaces[namespaceKey];

  if (root === undefined || root === null) {
    throw new MissingContextVariableException(rawPath);
  }

  // 3. Navegacion por reduccion, con tres cortes de seguridad en cada salto.
  const resolved = nestedKeys.reduce<unknown>((current, key) => {
    // a) Nunca se cruza hacia la cadena de prototipos.
    if (BLOCKED_KEYS.has(key)) {
      return undefined;
    }

    // b) Solo se navega sobre objetos y arreglos; un primitivo corta el camino.
    if (current === null || typeof current !== 'object') {
      return undefined;
    }

    // c) La propiedad debe ser PROPIA: cierra lo heredado (`toString`) y, de
    //    paso, los indices fuera de rango, que tampoco son claves propias.
    if (!Object.hasOwn(current, key)) {
      return undefined;
    }

    return (current as Record<string, unknown>)[key];
  }, root);

  // 4. Fail-safe: se cita `rawPath` y no la ruta normalizada, para que el
  //    mensaje mencione exactamente lo que el autor escribio en la plantilla.
  if (resolved === undefined || resolved === null) {
    throw new MissingContextVariableException(rawPath);
  }

  return resolved;
};

/**
 * Convierte un valor del contexto en el texto que va a la plantilla.
 *
 * Las ramas se escriben con `typeof` explicito en vez de un `String(value)`
 * sobre `unknown`: asi el compilador garantiza la cobertura y no se dispara
 * `no-base-to-string`. El `bigint` acompana a los numeros porque
 * `structuredClone` lo preserva y `JSON.stringify(1n)` lanza `TypeError`.
 */
const stringifyResolved = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }

  // Objetos y arreglos. `String()` a secas los convertiria en "[object Object]",
  // que se publicaria asi en el articulo destino: corrupcion silenciosa.
  return JSON.stringify(value);
};

/**
 * Contenedor inmutable de los resultados que los nodos van acumulando durante
 * una ejecucion del motor FSM.
 *
 * NO es `@Injectable()`: se instancia una vez por ejecucion y viaja como
 * argumento a `INodeStrategy.execute()`. Un provider de Nest seria un singleton
 * compartido entre ejecuciones concurrentes, que es justo lo contrario de lo
 * que este objeto necesita ser.
 *
 * INMUTABILIDAD ESTRICTA: toda entrada y toda salida pasa por `structuredClone`.
 * Con solo el operador spread la copia seria superficial y un
 * `context.getNamespace('ia').meta.titulo = 'otro'` alcanzaria el objeto
 * interno, corrompiendo un checkpoint que quiza ya se habia dado por bueno.
 * El clon profundo en ambas direcciones cierra esa via.
 */
export class StatePayloadContext {
  private readonly executionId: string;
  private readonly workflowId: string;
  private activeCursor: string;
  private namespaces: Record<string, Record<string, unknown>>;

  constructor(executionId: string, workflowId: string, initialStep: string) {
    this.executionId = executionId;
    this.workflowId = workflowId;
    this.activeCursor = initialStep;
    this.namespaces = {};
  }

  public getExecutionId(): string {
    return this.executionId;
  }

  public getWorkflowId(): string {
    return this.workflowId;
  }

  public getCursor(): string {
    return this.activeCursor;
  }

  public setCursor(nextStep: string): void {
    this.activeCursor = nextStep;
  }

  /**
   * Fusiona `data` en el namespace indicado sin mutar el estado anterior.
   *
   * Se clona el mapa completo y se reasigna: la referencia que tuviera un
   * checkpoint ya serializado sigue apuntando al objeto antiguo, intacto. El
   * spread sobre el namespace existente es una fusion, no un reemplazo, de modo
   * que un nodo puede escribir en dos tandas sin perder lo anterior.
   *
   * @param namespace Espacio de nombres propio del nodo (`outputNamespace`).
   * @param data Claves a incorporar; tambien se clona, para que mutarla despues
   *             de la llamada no alcance al contexto.
   */
  public setNamespace(namespace: string, data: Record<string, unknown>): void {
    const snapshot = structuredClone(this.namespaces);

    this.namespaces = {
      ...snapshot,
      [namespace]: {
        ...(snapshot[namespace] ?? {}),
        ...structuredClone(data),
      },
    };
  }

  /** Copia profunda del namespace, o `undefined` si ningun nodo lo ha escrito. */
  public getNamespace(namespace: string): Record<string, unknown> | undefined {
    const stored = this.namespaces[namespace];

    return stored === undefined ? undefined : structuredClone(stored);
  }

  /** Copia profunda de todo el contexto; es lo que se vuelca al checkpoint. */
  public getAllContext(): Record<string, Record<string, unknown>> {
    return structuredClone(this.namespaces);
  }

  /**
   * Sustituye las variables `{{ruta}}` de una plantilla por su valor.
   *
   * Admite rutas compuestas de cualquier profundidad, con notacion de punto y
   * de corchete indistintamente (ver `INTERPOLATION_PATTERN`). Una plantilla
   * sin marcas `{{ }}` se devuelve intacta.
   *
   * A diferencia de la implementacion de referencia de
   * `architecture-patterns.md` §3, una variable ausente NO se resuelve como
   * cadena vacia: lanza. Interpolar en silencio publicaria una noticia con el
   * titulo en blanco en vez de detener el flujo y levantar la alerta, y el
   * fallo apareceria aguas abajo, ya en Drupal, lejos de su causa.
   *
   * @throws MissingContextVariableException Si alguna ruta no resuelve.
   */
  public getInterpolatedValue(template: string): string {
    return template.replace(INTERPOLATION_PATTERN, (_match, rawPath: string) =>
      stringifyResolved(resolvePath(this.namespaces, rawPath)),
    );
  }
}
