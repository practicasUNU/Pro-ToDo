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
 * Los cuatro valores se declaran, pero solo `MOCK`, `GEMINI` y `ANTHROPIC`
 * tienen cliente implementado hoy; `OPENAI` no. Existe aqui igualmente para que
 * el contrato del DTO no cambie cuando llegue —y porque un `@IsEnum` que lo
 * rechazase al guardar obligaria a migrar los `params` de los flujos ya
 * escritos. `LlmProviderFactory` degrada al simulador lo que no tiene cliente.
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

/**
 * Codigo de un fallo que NO viene del transporte HTTP.
 *
 * Los de transporte ya los nombra `HttpClientService` (`ERR_HTTP_*`) y se
 * propagan tal cual; este cubre lo que falla DESPUES de una respuesta 200: un
 * cuerpo sin contenido generado o que no respeta el contrato JSON. Se separa
 * porque la decision de respaldo depende de esa distincion —cambiar de
 * proveedor tiene sentido ante una saturacion, no ante un contrato roto, que
 * volveria a romperse igual.
 */
export const ERR_LLM_PROVIDER_CONTRACT = 'ERR_LLM_PROVIDER_CONTRACT';

/**
 * Fallo de un cliente de proveedor, con el codigo que lo origino.
 *
 * Existe para que la estrategia pueda DECIDIR sin leer el mensaje. Hasta ahora
 * el codigo del cliente HTTP se aplanaba dentro del texto
 * (`` `${failure.code}: ${failure.message}` ``) y distinguir un 429 de cuota de
 * un 400 de payload habria exigido un `message.includes(...)`: un parser ad hoc
 * que envejece mal —ya dejo una rama muerta en `translateFailure`, buscando un
 * `ERR_NODE_HTTP_TIMEOUT` que no existe en ninguna parte—.
 *
 * El MENSAJE no cambia de forma: sigue llevando el codigo por delante, porque
 * es lo que acaba en el `.log` de disco y en la traza del nodo.
 */
export class LlmProviderException extends Error {
  constructor(
    message: string,
    /** `ERR_HTTP_*` del cliente, o `ERR_LLM_PROVIDER_CONTRACT`. */
    readonly code: string,
  ) {
    super(message);
    this.name = 'LlmProviderException';
  }
}

/** Parametros de ejecucion que el nodo traslada al cliente en cada llamada. */
export interface LlmExecutionOptions {
  /** Identificador del modelo concreto del proveedor (ej. `gemini-3.6-flash`). */
  readonly model: string;

  /** Espera maxima de la peticion saliente, en milisegundos. */
  readonly timeoutMs: number;

  /** Reintentos rapidos de red, adicionales al primer intento. */
  readonly maxRetries: number;

  /**
   * Para que se pide la inferencia: redactar o transcribir.
   *
   * OPCIONAL y con `'text'` implicito, de modo que ninguna llamada existente
   * cambia. Existe porque el simulador necesita distinguirlas: una
   * transcripcion vacia y una redaccion vacia se parecen demasiado, y un
   * desarrollador sin clave de API no podria saber si el rescate por OCR
   * funciono o si el nodo no llego a recibir los adjuntos.
   *
   * Se declara como MODO y no se deduce del prompt: comparar el texto del
   * prompt ataria el proveedor a una constante de otra capa, y bastaria retocar
   * una coma en ese texto para que la simulacion dejase de reconocerse.
   */
  readonly mode?: 'text' | 'ocr';

  /**
   * Aleatoriedad del muestreo, entre 0 y 1.
   *
   * OPCIONAL, y omitirla deja decidir al proveedor —que es lo que venia
   * pasando sin que nadie lo dijera: el nodo de OCR resolvia una temperatura de
   * `0.1` para transcribir con fidelidad y luego no la enviaba a ninguna parte,
   * asi que todas las transcripciones corrian con el valor por defecto del
   * modelo. Transcribir no es redactar, y la diferencia es exactamente esta.
   */
  readonly temperature?: number;

  /**
   * Tope de tokens de la respuesta.
   *
   * OPCIONAL: cada cliente aplica el suyo cuando falta. Es un limite de COSTE
   * ademas de de longitud, y por eso lo decide el nodo y no el proveedor.
   */
  readonly maxTokens?: number;
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
