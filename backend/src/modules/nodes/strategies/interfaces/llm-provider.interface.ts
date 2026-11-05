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
 * La respuesta del modelo se corto antes de terminar.
 *
 * Codigo PROPIO y no `ERR_LLM_PROVIDER_CONTRACT`, aunque el sintoma sea un
 * `JSON.parse` que falla: el contrato roto acusa al formato de la respuesta y
 * manda a mirar el prompt, cuando lo que hay que subir es el tope de tokens o
 * bajar el nivel de pensamiento. Confundirlos costo una auditoria entera.
 *
 * NO es motivo de respaldo dinamico (`provider-fallback.ts`): un tope corto lo
 * seria igual en el proveedor siguiente.
 */
export const ERR_LLM_PROVIDER_TRUNCATED = 'ERR_LLM_PROVIDER_TRUNCATED';

/**
 * Cuanto se le deja deliberar al modelo antes de responder.
 *
 * En la gama Gemini 3.x los tokens de pensamiento CUENTAN contra
 * `maxOutputTokens`, que es un corte duro sobre la suma de ambos. Un nodo que
 * transcribe no gana nada deliberando y si lo pierde todo: con el tope en 4096,
 * el modelo gastaba ~1000 tokens pensando y la transcripcion salia cortada a
 * media cadena JSON.
 *
 * `minimal` solo lo admiten las familias 3.5 y 3.6; el resto de la gama empieza
 * en `low` (ver `MODELS_SUPPORTING_MINIMAL_THINKING` en el cliente de Gemini).
 */
export type LlmThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

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
  /**
   * Consumo de la llamada que fallo DESPUES de que el proveedor respondiera
   * (contrato roto, respuesta truncada o vacia). Esa inferencia se factura igual
   * que una buena, y sin esto la telemetria solo veria las que salen bien.
   * `undefined` cuando el fallo fue de transporte y no hubo respuesta que medir.
   *
   * Mutable a proposito: lo adjunta `attachUsage` en el punto donde el cliente
   * ya conoce el `usage`, sin que cada `throw` del parser tenga que pasarlo.
   */
  usage?: LlmTokenUsage;

  constructor(
    message: string,
    /** `ERR_HTTP_*` del cliente, o `ERR_LLM_PROVIDER_CONTRACT`. */
    readonly code: string,
  ) {
    super(message);
    this.name = 'LlmProviderException';
  }
}

/**
 * Consumo de tokens de UNA inferencia, tal y como lo informa el proveedor.
 *
 * `tokensReasoning` solo cuenta lo que el proveedor factura APARTE de
 * `tokensCompletion` (los `thoughtsTokenCount` de Gemini). Anthropic incluye el
 * thinking dentro de `output_tokens`, asi que alli vale 0 y sumarlo contaria
 * dos veces el mismo gasto.
 *
 * `usageReported` es `false` cuando la respuesta no traia bloque de uso: los
 * contadores son entonces ceros por defecto, no una medicion, y la telemetria lo
 * marca como estimado.
 */
export interface LlmTokenUsage {
  readonly modelUsed: string;
  readonly tokensPrompt: number;
  readonly tokensCompletion: number;
  readonly tokensReasoning: number;
  readonly usageReported: boolean;
}

/**
 * Adjunta el consumo a un fallo del cliente y lo devuelve para relanzarlo.
 *
 * Solo toca `LlmProviderException`: cualquier otra cosa es un error imprevisto
 * del propio parser y se relanza intacta. No pisa un `usage` ya presente.
 */
export const attachUsage = (error: unknown, usage: LlmTokenUsage): unknown => {
  if (error instanceof LlmProviderException) {
    error.usage ??= usage;
  }

  return error;
};

/** Parametros de ejecucion que el nodo traslada al cliente en cada llamada. */
export interface LlmExecutionOptions {
  /** Identificador del modelo concreto del proveedor (ej. `gemini-3.6-flash`). */
  readonly model: string;

  /** Espera maxima de la peticion saliente, en milisegundos. */
  readonly timeoutMs: number;

  /** Reintentos rapidos de red, adicionales al primer intento. */
  readonly maxRetries: number;

  /**
   * Espera base del backoff entre reintentos, en milisegundos.
   *
   * OPCIONAL, al reves que los dos de arriba, y la asimetria es deliberada: el
   * cliente HTTP ya tiene un defecto razonable (`DEFAULT_HTTP_BASE_DELAY_MS`) y
   * declararla obligatoria forzaria a inventarle un valor a cada llamante que
   * no tiene opinion —el simulador, el catalogo de proveedores— para no romper
   * el tipo. Omitida, el cliente aplica el suyo, que es como funciono hasta hoy.
   */
  readonly baseDelayMs?: number;

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
   *
   * CUIDADO: en Gemini 3.x este tope cubre tambien los tokens de pensamiento,
   * asi que no es el tamano de la respuesta sino el presupuesto total. Ver
   * `thinkingLevel`.
   */
  readonly maxTokens?: number;

  /**
   * Cuanto deliberar antes de responder.
   *
   * OPCIONAL y omitido por defecto, por el mismo motivo que `temperature` y
   * `maxTokens`: el defecto lo publica cada proveedor y cambia con el modelo.
   * Hoy solo lo entiende el cliente de Gemini; el resto lo ignora sin romperse.
   */
  readonly thinkingLevel?: LlmThinkingLevel;

  /**
   * Si la respuesta debe traer ademas la plantilla base ya rellena.
   *
   * Gobierna el CONTRATO que se le pide al modelo, no solo una preferencia: con
   * el activo, `buildResponseContractInstruction` anade la directiva de
   * maquetado y `buildResponseJsonSchema` declara —y exige— `filled_markup`.
   *
   * Se declara como INDICADOR y no se deduce del texto del prompt, por el mismo
   * motivo que `mode`: comparar el prompt ataria el proveedor a una constante de
   * otra capa. Quien decide es la estrategia, que es la unica que sabe si su
   * instruccion cita una plantilla base.
   *
   * OPCIONAL, con `false` implicito: las llamadas que no lo pasan —el nodo de
   * OCR, la prueba de conectividad del catalogo— siguen recibiendo exactamente
   * el contrato de tres claves de siempre.
   */
  readonly expectsFilledMarkup?: boolean;

  /**
   * Si la respuesta puede traer un LOTE de elementos (cardinalidad 1 a N).
   *
   * Con el activo, el contrato anade la clave `items` con el reparto
   * ASIMETRICO: la raiz describe el primer elemento —como siempre— e `items`
   * solo los restantes, del segundo en adelante (vacio si hay uno). Asi el
   * marcado del primero no se genera dos veces y todo lo que hoy lee la raiz
   * (`{{llm_response.headline}}`) sigue valiendo.
   *
   * INDICADOR y no deduccion del prompt, por el mismo motivo que
   * `expectsFilledMarkup`. OPCIONAL, con `false` implicito.
   */
  readonly expectsItems?: boolean;

  /**
   * Cardinalidad TOLERANTE (modo `AUTO` del nodo). Solo tiene efecto junto a
   * `expectsItems`: el esquema es el mismo, pero la regla del contrato pide al
   * modelo que DETECTE si el material trae uno o varios elementos en vez de
   * darlo por hecho. OPCIONAL, con `false` implicito.
   */
  readonly autoDetectItems?: boolean;
}

/**
 * Un elemento adicional del lote (`items`), con las mismas claves que la raiz.
 *
 * `source_url` es opcional: solo lo aporta el modelo cuando el material cita
 * de donde sale cada elemento (por ejemplo, una noticia de un boletin).
 */
export interface LlmResponseItem {
  headline: string;
  summary: string;
  body_paragraphs: string[];
  filled_markup?: string;
  source_url?: string;
}

/**
 * Regla de cardinalidad que se anade al contrato cuando se espera un lote.
 *
 * Exportada para que el optimizador de prompts y las pruebas citen el MISMO
 * texto que reciben los proveedores.
 */
export const RESPONSE_ITEMS_RULE = [
  'Incluye ademas la clave "items" (array de objetos). REGLA DE CARDINALIDAD:',
  'si el material contiene un unico elemento, colocalo en la raiz y deja "items"',
  'como array vacio []. Si contiene varios, coloca en la raiz el PRIMER elemento',
  'y en "items" un objeto por cada elemento RESTANTE (del segundo en adelante),',
  'cada uno con sus propias claves "headline", "summary" y "body_paragraphs",',
  'su "filled_markup" si se te pide maquetado, y "source_url" si el material',
  'indica de donde procede. Queda prohibido repetir el primer elemento dentro',
  'de "items".',
].join(' ');

/**
 * Variante tolerante de `RESPONSE_ITEMS_RULE` para la cardinalidad `AUTO`.
 *
 * Mismo reparto asimetrico y mismas claves; cambia el tono: el lote no se da
 * por supuesto. Con un unico elemento la respuesta es exactamente la de 1 a 1
 * mas `"items": []`, y nunca se trocea un elemento para fabricar un lote.
 */
export const RESPONSE_ITEMS_AUTO_RULE = [
  'Incluye ademas la clave "items" (array de objetos). REGLA DE CARDINALIDAD',
  'TOLERANTE: primero determina si el material describe UN elemento o VARIOS',
  'independientes. Si es uno, colocalo en la raiz y deja "items" como array',
  'vacio []; no lo dividas en partes para fabricar un lote. Si son varios, coloca',
  'en la raiz el PRIMER elemento y en "items" un objeto por cada elemento',
  'RESTANTE, cada uno con sus propias claves "headline", "summary" y',
  '"body_paragraphs", su "filled_markup" si se te pide maquetado, y "source_url"',
  'si el material indica de donde procede. Queda prohibido repetir el primer',
  'elemento dentro de "items".',
].join(' ');

/**
 * Frase que describe al modelo la forma exacta de la respuesta.
 *
 * POR QUE VIVE AQUI Y NO EN CADA CLIENTE. Hasta ahora este literal estaba
 * duplicado byte a byte en `GeminiLlmProvider` y `AnthropicLlmProvider`, y la
 * duplicacion era DELIBERADA: el TSDoc de Anthropic argumentaba que compartirlo
 * invitaria a ajustarlo para un proveedor rompiendo al otro, y que la frontera
 * de reutilizacion del nodo es `ILlmProviderClient`, no el texto.
 *
 * Ese calculo cambio cuando el contrato dejo de ser fijo. Dos literales
 * CONSTANTES e identicos se mantienen sincronizados de un vistazo; dos literales
 * con una RAMA condicional, no. El dia que alguien tocara solo uno, el sintoma
 * seria que un flujo con plantilla funciona con Gemini y falla con Anthropic
 * —o al reves— sin una sola excepcion que lo delate, porque el escudo
 * posterior se limitaria a decir que no llego markup. La frontera sigue siendo
 * `ILlmProviderClient` para el COMPORTAMIENTO; lo que se centraliza es el
 * CONTRATO, que por definicion tiene que ser el mismo para los dos.
 *
 * Cada cliente conserva lo suyo: Anthropic ademas adjunta el esquema de
 * `buildResponseJsonSchema`, y Gemini se queda solo con esta frase mas su
 * `responseMimeType`, porque su API no admite esquema.
 */
export const buildResponseContractInstruction = (
  expectsFilledMarkup: boolean,
  expectsItems = false,
  autoDetectItems = false,
): string => {
  const keys = [
    'Responde EXCLUSIVAMENTE con un objeto JSON valido, sin texto adicional',
    'ni marcas de bloque de codigo, con exactamente estas claves:',
    '"headline" (string), "summary" (string) y "body_paragraphs" (array de strings).',
  ].join(' ');
  // La regla del lote va justo detras de las claves y antes del maquetado: la
  // directiva de `filled_markup` aplica igual a la raiz y a cada elemento.
  const itemsRule = autoDetectItems
    ? RESPONSE_ITEMS_AUTO_RULE
    : RESPONSE_ITEMS_RULE;
  const base = expectsItems ? `${keys} ${itemsRule}` : keys;

  if (!expectsFilledMarkup) {
    return base;
  }

  // La directiva de maquetado es imperativa a proposito: "respeta" y no
  // "procura respetar". Lo que esta en juego son los selectores que el
  // ESCUDO_POST_IA audita despues, y un modelo que reescriba la estructura a su
  // gusto deja el flujo PAUSADO con ERR_POST_IA_DOM_MUTATED.
  return [
    base,
    'Se te ha suministrado ademas una plantilla HTML base dentro de las instrucciones.',
    'Incluye una clave adicional "filled_markup" (string) con esa MISMA plantilla',
    'y el contenido redactado ya inyectado dentro de sus contenedores semanticos.',
    'Respeta estrictamente sus etiquetas, clases CSS e imagenes: no anadas,',
    'renombres ni elimines elementos, y no envuelvas el HTML en bloques de codigo.',
    // Regla aparte para las tablas porque es donde los modelos "ordenan" el
    // markup: una plantilla puede llevar varios `<tbody>` en la misma tabla
    // (uno vacio para las filas generadas y otros estaticos), y fusionarlos o
    // descartar el vacio dejaba el flujo PAUSADO con ERR_POST_IA_DOM_MUTATED.
    // La regla es agnostica a proposito: el selector concreto que se audita
    // despues lo declara cada nodo ESCUDO_POST_IA en `requiredSelectors`.
    'En las tablas conserva cada <thead>, <tbody> y <tfoot> con su clase y en su',
    'orden original, aunque una tabla tenga varios <tbody> o alguno venga vacio.',
    'Un <tbody> vacio de la plantilla es el contenedor de las filas generadas:',
    'las filas <tr> que generes van DENTRO de el; nunca lo fusiones con otro',
    '<tbody>, lo renombres ni lo elimines, y deja sin tocar los <tbody> estaticos.',
  ].join(' ');
};

/**
 * Esquema de salida para los proveedores que admiten JSON Schema (hoy, Anthropic).
 *
 * `additionalProperties: false` es lo que obliga a declarar aqui cualquier clave
 * nueva: sin figurar en `properties`, el modelo tiene PROHIBIDO emitirla, por
 * mucho que la instruccion de texto se la pida.
 *
 * `filled_markup` entra en `required` SOLO cuando se espera. Es la diferencia
 * entre pedirlo y confiar: bajo un prompt largo —y uno que lleva una plantilla
 * HTML completa lo es— un campo meramente opcional es justo el que el modelo
 * omite, y el sintoma seria un `ERR_POST_IA_EMPTY_HTML` intermitente, de los que
 * no se reproducen a voluntad. Cuando NO se espera, exigirlo seria peor:
 * obligaria a inventar markup a un flujo que no tiene plantilla ninguna.
 */
export const buildResponseJsonSchema = (
  expectsFilledMarkup: boolean,
  expectsItems = false,
) => {
  const fieldProperties = {
    headline: { type: 'string' },
    summary: { type: 'string' },
    body_paragraphs: { type: 'array', items: { type: 'string' } },
    ...(expectsFilledMarkup
      ? {
          filled_markup: {
            type: 'string',
            description:
              'La plantilla HTML base suministrada, con el contenido redactado ya inyectado en sus contenedores semanticos.',
          },
        }
      : {}),
  };
  const fieldRequired = expectsFilledMarkup
    ? ['headline', 'summary', 'body_paragraphs', 'filled_markup']
    : ['headline', 'summary', 'body_paragraphs'];

  // Cada elemento del lote repite el contrato de la raiz, mas un `source_url`
  // opcional. `items` es OBLIGATORIO cuando se pide —puede ir vacio—, por el
  // mismo motivo que `filled_markup`: un campo opcional es el que el modelo
  // omite bajo un prompt largo, y un lote callado se publicaria como uno solo.
  return {
    type: 'object',
    properties: {
      ...fieldProperties,
      ...(expectsItems
        ? {
            items: {
              type: 'array',
              description:
                'Elementos del lote a partir del SEGUNDO; vacio si solo hay uno.',
              items: {
                type: 'object',
                properties: {
                  ...fieldProperties,
                  source_url: { type: 'string' },
                },
                required: fieldRequired,
                additionalProperties: false,
              },
            },
          }
        : {}),
    },
    required: expectsItems ? [...fieldRequired, 'items'] : fieldRequired,
    additionalProperties: false,
  } as const;
};

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
  /**
   * Plantilla base devuelta ya rellena, cuando se pidio con
   * `LlmExecutionOptions.expectsFilledMarkup`.
   *
   * OPCIONAL y no obligatoria. Lo es por dos razones distintas y las dos
   * mandan: la primera es que una inferencia sin plantilla delante no tiene
   * nada que devolver aqui; la segunda es que este tipo lo construyen literales
   * completos en las pruebas del nodo de OCR y del catalogo de proveedores, que
   * no tienen nada que ver con el maquetado y no deberian dejar de compilar por
   * un campo que jamas van a usar.
   *
   * `undefined` y no `null` cuando falta: la normalizacion a `null` —que es lo
   * que acaba publicado en el namespace— la hace la estrategia, no el cliente.
   * Asi un `toEqual` sobre el payload de un proveedor que no lo emite sigue
   * describiendo el contrato de tres claves sin mencionarlo.
   */
  filled_markup?: string;
  /**
   * Elementos del lote del segundo en adelante, cuando se pidio con
   * `LlmExecutionOptions.expectsItems`. OPCIONAL por el mismo motivo que
   * `filled_markup`: los literales de prueba de otros nodos no lo usan.
   */
  items?: LlmResponseItem[];
  metadata: {
    tokensPrompt: number;
    tokensCompletion: number;
    /**
     * Tokens de razonamiento facturados aparte (ver `LlmTokenUsage`). OPCIONAL
     * por el mismo motivo que `filled_markup`: los literales de prueba de otros
     * nodos no deberian dejar de compilar por un contador que no usan.
     */
    tokensReasoning?: number;
    /** `false` si el proveedor no informo de uso; ausente equivale a `true`. */
    usageReported?: boolean;
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

/**
 * Normaliza la clave `items` que redacto el modelo, sea cual sea el proveedor.
 *
 * Vive aqui y no en cada cliente por el motivo de `buildResponseContractInstruction`:
 * es CONTRATO, y dos copias divergirian. Descarta todo lo que no sea un objeto
 * y recorta cada campo como lo hacen los clientes con la raiz; un elemento sin
 * titular, sin resumen y sin parrafos no describe nada y tambien se descarta.
 *
 * Devuelve `undefined` si `raw` no es un array, para que el cliente propague la
 * clave solo cuando el modelo la emitio, igual que hace con `filled_markup`.
 */
export const normalizeResponseItems = (
  raw: unknown,
): LlmResponseItem[] | undefined => {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const asText = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : '';
  const asOptionalText = (value: unknown): string | undefined => {
    const text = asText(value);

    return text.length > 0 ? text : undefined;
  };

  return raw
    .filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === 'object' && entry !== null && !Array.isArray(entry),
    )
    .map((entry) => {
      const paragraphs = Array.isArray(entry.body_paragraphs)
        ? entry.body_paragraphs
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        : [];
      const filledMarkup = asOptionalText(entry.filled_markup);
      const sourceUrl = asOptionalText(entry.source_url);

      return {
        headline: asText(entry.headline),
        summary: asText(entry.summary),
        body_paragraphs: paragraphs,
        ...(filledMarkup === undefined ? {} : { filled_markup: filledMarkup }),
        ...(sourceUrl === undefined ? {} : { source_url: sourceUrl }),
      };
    })
    .filter(
      (item) =>
        item.headline.length > 0 ||
        item.summary.length > 0 ||
        item.body_paragraphs.length > 0 ||
        item.filled_markup !== undefined,
    );
};
