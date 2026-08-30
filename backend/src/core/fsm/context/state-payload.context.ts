/**
 * Patron de variable interpolable: `{{namespace.campo}}`, con espacios opcionales.
 *
 * Solo admite `[a-zA-Z0-9_]` a ambos lados del punto, que es exactamente el
 * juego de caracteres que `OUTPUT_NAMESPACE_PATTERN` impone a los namespaces en
 * `pipeline-schema.types.ts`. Un namespace con guiones nunca podria resolverse
 * desde una plantilla, y por eso el DTO lo prohibe de entrada.
 */
const INTERPOLATION_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\s*\}\}/g;

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
   * Sustituye las variables `{{nodo.campo}}` de una plantilla por su valor.
   *
   * A diferencia de la implementacion de referencia de
   * `architecture-patterns.md` §3, una variable ausente NO se resuelve como
   * cadena vacia: lanza. Interpolar en silencio publicaria una noticia con el
   * titulo en blanco en vez de detener el flujo y levantar la alerta, y el
   * fallo aparecerian aguas abajo, ya en Drupal, lejos de su causa.
   *
   * @throws MissingContextVariableException Si la variable falta o vale `null`.
   */
  public getInterpolatedValue(template: string): string {
    return template.replace(
      INTERPOLATION_PATTERN,
      (_match, nodeKey: string, fieldKey: string) => {
        const value = this.namespaces[nodeKey]?.[fieldKey];

        if (value === undefined || value === null) {
          throw new MissingContextVariableException(`${nodeKey}.${fieldKey}`);
        }

        // Las cadenas se insertan tal cual; el resto pasa por JSON.stringify.
        // `String()` a secas convertiria un objeto en "[object Object]", que se
        // publicaria asi en el articulo destino: una corrupcion silenciosa e
        // indiagnosticable. JSON.stringify cubre ademas numeros y booleanos sin
        // anadir comillas (42 -> "42"), asi que resuelve todo el rango.
        return typeof value === 'string' ? value : JSON.stringify(value);
      },
    );
  }
}
