/**
 * Contrato polimorfico de los clientes de modelo de lenguaje.
 *
 * Es al nodo `PROCESADOR_IA` lo que `INodeStrategy` es al motor: el punto donde
 * se cambia de proveedor sin tocar la estrategia. Anadir ChatGPT o Claude es
 * implementar esta interfaz y mapearla en `resolveProvider`, no editar el flujo
 * de `execute`.
 *
 * DESACOPLAMIENTO DEL PROMPT: el cliente recibe TEXTO ya interpolado. No conoce
 * `StatePayloadContext`, ni los namespaces, ni la tabla `plantillas_prompts_ia`.
 * Resolver la plantilla e interpolar las variables es trabajo de la estrategia;
 * si el proveedor lo hiciera, cada nuevo proveedor tendria que repetirlo y los
 * cuatro divergirian a la primera correccion.
 */

/**
 * Proveedores declarables en la configuracion del nodo.
 *
 * Es un enum y no un union type porque `@IsEnum()` de class-validator necesita
 * un objeto disponible en runtime, el mismo motivo por el que `NodeType` lo es.
 *
 * Los cuatro valores se declaran, pero solo `MOCK` y `GEMINI` tienen cliente
 * implementado hoy. Los otros dos existen aqui para que el contrato del DTO no
 * cambie cuando lleguen —y porque un `@IsEnum` que los rechazase al guardar
 * obligaria a migrar los `params` de los flujos ya escritos.
 */
export enum LlmProvider {
  GEMINI = 'GEMINI',
  ANTHROPIC = 'ANTHROPIC',
  OPENAI = 'OPENAI',
  MOCK = 'MOCK',
}

/**
 * Adjunto que el modelo lee directamente, sin pasar por texto.
 *
 * Es la entrada del modo VISION: el correo cuyo unico contenido real es una
 * imagen o un PDF escaneado no produce `clean_body` que enviar, y hasta ahora el
 * pipeline se quedaba ahi. `PARSER_PRE_IA` ya sabia detectar ese caso —lo marca
 * con `requires_multimodal_fallback`— pero no habia quien lo atendiese.
 *
 * `contentBase64` viaja tal cual lo deposito `TRIGGER_IMAP` en
 * `raw_email.attachments[]`. Que siga ahi cuando el nodo de vision corre no es
 * casualidad: la politica de liberacion de binarios del motor conserva los bytes
 * mientras ningun nodo haya extraido texto, y ademas nunca purga en la rama de
 * fallo, que es por donde se llega aqui.
 *
 * `snake_case` en `contentBase64`? No: esta interfaz es codigo TypeScript y no
 * un payload de namespace. La frontera de nomenclatura esta en `LlmResponsePayload`,
 * cuyas claves si acaban en el contexto.
 */
export interface LlmInlineAttachment {
  readonly filename: string;
  /** MIME real del adjunto: `image/*` o `application/pdf`. */
  readonly contentType: string;
  /** Contenido en base64, sin el prefijo `data:`. */
  readonly contentBase64: string;
}

/** Parametros de ejecucion que el nodo traslada al cliente en cada llamada. */
export interface LlmExecutionOptions {
  /** Identificador del modelo concreto del proveedor (ej. `gemini-1.5-flash`). */
  readonly model: string;

  /** Espera maxima de la peticion saliente, en milisegundos. */
  readonly timeoutMs: number;

  /** Reintentos rapidos de red, adicionales al primer intento. */
  readonly maxRetries: number;
}

/**
 * Contrato FORMAL de salida del nodo de IA.
 *
 * Las claves van en `snake_case` porque son lo que acaba publicado en el
 * namespace `llm_response` del `StatePayloadContext`, y de ahi lo lee el
 * `MAPEADOR_PLANTILLA` como `{{llm_response.headline}}`. El resto del codigo
 * TypeScript usa `camelCase`; la frontera esta justo aqui, igual que en
 * `parsed_email` y `scraped_web`.
 *
 * `metadata` NO es decorativa: `isMock` es lo que permite a un operador
 * distinguir una redaccion real de una simulada de coste cero al auditar una
 * ejecucion, y los dos contadores de tokens son la unica traza del gasto.
 */
export interface LlmResponsePayload {
  headline: string;
  summary: string;
  body_paragraphs: string[];
  metadata: {
    tokensPrompt: number;
    tokensCompletion: number;
    modelUsed: string;
    isMock: boolean;
  };
}

/** Cliente de un proveedor concreto de modelo de lenguaje. */
export interface ILlmProviderClient {
  readonly provider: LlmProvider;

  /**
   * Ejecuta la inferencia y devuelve el contrato formal ya estructurado.
   *
   * LANZA ante un fallo del proveedor, al reves que una `INodeStrategy`. Es
   * deliberado: la excepcion es la senal que alimenta el contador del freno de
   * emergencia de la estrategia, que necesita distinguir "el proveedor no
   * responde" de "el proveedor respondio algo que no sirve".
   *
   * `attachments` es OPCIONAL, y esa opcionalidad es lo que permite anadir el
   * modo vision sin tocar los clientes que no lo soportan: un proveedor que lo
   * ignore sigue cumpliendo el contrato y sigue compilando. Quien decide si hay
   * proveedor capaz es la estrategia, no esta interfaz.
   */
  generateCompletion(
    prompt: string,
    systemPrompt?: string,
    config?: LlmExecutionOptions,
    attachments?: readonly LlmInlineAttachment[],
  ): Promise<LlmResponsePayload>;
}
