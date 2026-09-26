import { Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  MissingContextVariableException,
  extractNamespaceRoots,
} from '@core/fsm/context/state-payload.context';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { AiPromptTemplatesService } from '@modules/ai-prompt-templates/ai-prompt-templates.service';
import {
  LlmExtractorConfigDto,
  resolveLlmExtractorConfig,
} from '@modules/nodes/dto/llm-extractor-config.dto';
import { LlmProvider } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import { GeminiLlmProvider } from '@modules/nodes/strategies/providers/gemini-llm.provider';
import { MockLlmProvider } from '@modules/nodes/strategies/providers/mock-llm.provider';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type {
  INodeStrategy,
  NodeErrorDetail,
  NodeOutputField,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';
import type { ResolvedLlmExtractorConfig } from '@modules/nodes/dto/llm-extractor-config.dto';
import type {
  ILlmProviderClient,
  LlmResponsePayload,
} from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import type { ValidatorOptions } from 'class-validator';

/** Codigos de fallo propios de este nodo. */
export const ERR_LLM_CONFIG = 'ERR_LLM_CONFIG';
export const ERR_LLM_MISSING_INPUT_TEXT = 'ERR_LLM_MISSING_INPUT_TEXT';
export const ERR_LLM_PROMPT_UNRESOLVED = 'ERR_LLM_PROMPT_UNRESOLVED';
export const ERR_LLM_INTERPOLATION = 'ERR_LLM_INTERPOLATION';
export const ERR_LLM_PROVIDER_UNSUPPORTED = 'ERR_LLM_PROVIDER_UNSUPPORTED';
export const ERR_LLM_PROVIDER_FAILURE = 'ERR_LLM_PROVIDER_FAILURE';
export const ERR_LLM_EMERGENCY_BRAKE = 'ERR_LLM_EMERGENCY_BRAKE';

/**
 * Las cuatro claves que este nodo deposita en su namespace.
 *
 * Se exporta como tupla `as const` y no como un `string[]` para que el selector
 * Poka-Yoke del frontend y las pruebas puedan derivar el tipo de las claves en
 * lugar de repetirlas a mano.
 */
export const LLM_OUTPUT_KEYS = [
  'headline',
  'summary',
  'body_paragraphs',
  'metadata',
] as const;

/** Opciones de validacion canonicas del repositorio. */
const VALIDATION_OPTIONS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

/**
 * Origenes del texto a procesar, EN ORDEN DE PRIORIDAD.
 *
 * `parsed_email.clean_body` primero porque, cuando ambos existen, el correo es
 * el disparador del flujo y la pagina extraida solo lo amplia. Un flujo que
 * arranca por cron no tiene correo y cae al segundo sin mas.
 */
const INPUT_TEXT_SOURCES = [
  { namespace: 'parsed_email', field: 'clean_body' },
  { namespace: 'scraped_web', field: 'full_article_content' },
] as const;

/** Union discriminada: o hay configuracion, o hay un fallo que devolver. */
type LlmConfigResolution =
  | { readonly config: ResolvedLlmExtractorConfig }
  | { readonly failure: NodeErrorDetail };

/** Union discriminada del prompt ya resuelto contra la base de datos. */
type PromptResolution =
  | { readonly prompt: string }
  | { readonly failure: NodeErrorDetail };

/** Traza completa del error, si la hay, lista para fusionar en el detalle. */
const stackTraceOf = (error: unknown): { stackTrace?: string } =>
  error instanceof Error && error.stack !== undefined
    ? { stackTrace: error.stack }
    : {};

/**
 * Nodo PROCESADOR_IA: convierte texto en bruto en una redaccion estructurada.
 *
 * Es el consumidor natural de `parsed_email.clean_body` y de
 * `scraped_web.full_article_content`, y su salida —`llm_response`— alimenta al
 * `MAPEADOR_PLANTILLA`, que la interpola como `{{llm_response.headline}}`.
 *
 * NODO PURO: no escribe en el contexto. Devuelve `data` y es `FsmEngineService`
 * quien la deposita en el `outputNamespace` declarado por el `pipeline_schema`.
 *
 * TODOS los fallos son GRAVE SALVO el freno de emergencia, y la excepcion tiene
 * motivo. Solo los GRAVE entran en la politica de reintentos del motor
 * (`FsmEngineService.canRetry`), y casi todo lo que puede ir mal aqui —un prompt
 * sin elegir, una variable que no resuelve, un proveedor caido— es algo que el
 * operador mira y corrige con el flujo PAUSADO (CU-09). El freno es lo contrario
 * por definicion: declara que insistir es precisamente el problema.
 *
 * LAS DOS CAPAS DE REINTENTO Y EL DINERO. `HttpClientService` reintenta la
 * PETICION con backoff, y el motor reintenta el NODO entero. Ambas facturan
 * tokens en cada vuelta, y multiplicadas pueden convertir un proveedor
 * intermitente en una factura que nadie decidio. El freno de emergencia es el
 * corte de esa espiral: cuenta los fallos CONSECUTIVOS del proveedor dentro de
 * la misma ejecucion y, al alcanzar el umbral, devuelve URGENTE —que `canRetry`
 * no reintenta— dejando la ejecucion PAUSADA con el cursor intacto.
 */
@Injectable()
export class LlmExtractorStrategy implements INodeStrategy {
  public readonly nodeType = NodeType.PROCESADOR_IA;

  private readonly logger = new Logger(LlmExtractorStrategy.name);

  /**
   * Fallos CONSECUTIVOS del proveedor, indexados por ejecucion y nodo.
   *
   * Es un `Map` y no un contador de instancia porque esta estrategia es un
   * singleton de Nest COMPARTIDO por todas las ejecuciones concurrentes. Con un
   * unico numero, un flujo que agota su umbral frenaria el nodo de IA de
   * cualquier otro flujo sano que entrase despues —y el operador vería una
   * ejecucion pausada sin un solo fallo propio que lo explique.
   * `testing-standards.md` §4 exige justamente ese aislamiento.
   *
   * La entrada se BORRA en cuanto el nodo cierra, acierte o frene, para no
   * acumular claves de ejecuciones ya muertas.
   */
  private readonly consecutiveFailures = new Map<string, number>();

  /**
   * Las cuatro claves que este nodo deposita en su namespace.
   *
   * `body_paragraphs` y `metadata` se declaran `object` y no un tipo de arreglo
   * porque `NodeOutputFieldType` no contempla `text[]`. Ampliar ese union
   * arrastraria al validador de topologia y a `requiredUpstreamFieldTypes` de
   * todos los nodos, y ningun consumidor pide hoy esa distincion.
   */
  public readonly outputFields: readonly NodeOutputField[] = [
    { name: 'headline', type: 'text', description: 'Titular redactado' },
    { name: 'summary', type: 'text', description: 'Entradilla o resumen' },
    {
      name: 'body_paragraphs',
      type: 'object',
      description: 'Parrafos del cuerpo, en orden',
    },
    {
      name: 'metadata',
      type: 'object',
      description: 'Tokens consumidos, modelo usado y marca isMock',
    },
  ];

  /** El mismo DTO que valida `execute`, ahora tambien al GUARDAR el esquema. */
  public readonly paramsSchema = LlmExtractorConfigDto;

  constructor(
    private readonly aiPromptTemplatesService: AiPromptTemplatesService,
    private readonly mockProvider: MockLlmProvider,
    private readonly geminiProvider: GeminiLlmProvider,
  ) {}

  public async execute(
    context: StatePayloadContext,
    params: Record<string, unknown>,
  ): Promise<NodeResult> {
    const resolution = await this.resolveConfig(params);

    if ('failure' in resolution) {
      return { success: false, error: resolution.failure };
    }

    const { config } = resolution;
    const brakeKey = this.buildBrakeKey(context);

    // Guarda de CONTENIDO. Va antes de resolver el prompt porque es la mas
    // barata de las dos —mira el contexto que ya esta en memoria— y porque sin
    // texto de entrada no hay inferencia que preparar, tenga o no plantilla.
    const inputText = this.resolveInputText(context);

    if (inputText === null) {
      this.consecutiveFailures.delete(brakeKey);

      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_LLM_MISSING_INPUT_TEXT,
          message:
            'Falta contenido textual previo en el contexto para procesar la inferencia',
          missingFields: INPUT_TEXT_SOURCES.map(
            (source) => `${source.namespace}.${source.field}`,
          ),
        },
      };
    }

    const promptResolution = await this.resolvePrompt(config);

    if ('failure' in promptResolution) {
      this.consecutiveFailures.delete(brakeKey);

      return { success: false, error: promptResolution.failure };
    }

    const interpolated = this.interpolate(context, promptResolution.prompt);

    if ('failure' in interpolated) {
      this.consecutiveFailures.delete(brakeKey);

      return { success: false, error: interpolated.failure };
    }

    const client = this.resolveProvider(config);

    if (client === null) {
      this.consecutiveFailures.delete(brakeKey);

      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_LLM_PROVIDER_UNSUPPORTED,
          message: `El proveedor "${config.provider}" todavia no tiene cliente implementado. Usa ${LlmProvider.GEMINI} o ${LlmProvider.MOCK}.`,
          missingFields: ['provider'],
        },
      };
    }

    let response: LlmResponsePayload;

    try {
      // El TEXTO va como prompt y la INSTRUCCION como systemPrompt, y no al
      // reves. El motivo es que asi el contenido llega al modelo aunque la
      // instruccion del operador no incluya ningun marcador que lo interpole:
      // un prompt como "resume esto en tres parrafos" es perfectamente valido y
      // no menciona ningun namespace. Con el reparto contrario, ese prompt
      // facturaria una inferencia sobre ningun contenido.
      response = await client.generateCompletion(
        inputText,
        interpolated.prompt,
        {
          model: config.model,
          timeoutMs: config.timeoutMs,
          maxRetries: config.maxRetries,
        },
      );
    } catch (error) {
      return this.registerFailure(brakeKey, config, error);
    }

    // Exito: el contador se reinicia. El freno cuenta fallos CONSECUTIVOS, y una
    // inferencia correcta demuestra que el proveedor responde; conservar los
    // fallos anteriores frenaria mas tarde por una racha que ya se rompio.
    this.consecutiveFailures.delete(brakeKey);

    return {
      success: true,
      data: {
        headline: response.headline,
        summary: response.summary,
        body_paragraphs: response.body_paragraphs,
        metadata: response.metadata,
      },
    };
  }

  /**
   * Namespaces que el prompt en linea necesita para resolverse.
   *
   * Se derivan con el MISMO extractor que alimenta la interpolacion real, de
   * modo que lo que aqui se exige y lo que alli se resuelve no discrepen.
   *
   * DEVUELVE VACIO con `templatePromptId`, y es inevitable: el texto de la
   * plantilla vive en `plantillas_prompts_ia` y leerlo seria I/O, mientras que
   * el contrato de `INodeStrategy` exige que este metodo sea PURO y SINCRONO.
   * La comprobacion no se pierde, se mueve: un marcador que no resuelva se
   * diagnostica en ejecucion como `ERR_LLM_INTERPOLATION`, nombrando la
   * variable concreta.
   */
  public getRequiredNamespaces(
    params: Record<string, unknown>,
  ): readonly string[] {
    return typeof params.inlinePrompt === 'string'
      ? extractNamespaceRoots(params.inlinePrompt)
      : [];
  }

  /**
   * Sin instruccion no hay nodo que ejecutar.
   *
   * El resto de campos tiene defecto en el DTO; el prompt no puede tenerlo,
   * porque es la decision editorial concreta de este flujo. Lo consulta
   * `assertActivatable`: un flujo se GUARDA a medias —es un borrador— pero no se
   * ACTIVA sin instruccion.
   */
  public getIncompleteParams(
    params: Record<string, unknown>,
  ): readonly string[] {
    const hasTemplate =
      typeof params.templatePromptId === 'string' &&
      params.templatePromptId.trim().length > 0;
    const hasInline =
      typeof params.inlinePrompt === 'string' &&
      params.inlinePrompt.trim().length > 0;

    return hasTemplate || hasInline ? [] : ['templatePromptId | inlinePrompt'];
  }

  /**
   * Valida `params` y aplica los valores por defecto.
   *
   * Se usa `validate` y NO `validateOrReject`: esta ultima lanza, y el motor
   * normaliza toda excepcion a URGENTE, que `canRetry` nunca reintenta.
   */
  private async resolveConfig(
    params: Record<string, unknown>,
  ): Promise<LlmConfigResolution> {
    const dto = plainToInstance(LlmExtractorConfigDto, params);
    const errors = await validate(dto, VALIDATION_OPTIONS);

    if (errors.length > 0) {
      const constraints = errors.flatMap((error) =>
        Object.values(error.constraints ?? {}),
      );

      return {
        failure: {
          level: 'GRAVE',
          code: ERR_LLM_CONFIG,
          message: `Configuracion invalida del nodo procesador de IA: ${constraints.join(' ')}`,
          missingFields: errors.map((error) => error.property),
        },
      };
    }

    return { config: resolveLlmExtractorConfig(dto) };
  }

  /**
   * Texto a procesar, o `null` si ningun origen lo aporta.
   *
   * Recorre `INPUT_TEXT_SOURCES` en orden y devuelve el primero con contenido.
   * Una cadena de solo espacios cuenta como ausencia: mandarla al modelo
   * facturaria tokens por procesar nada.
   */
  private resolveInputText(context: StatePayloadContext): string | null {
    for (const source of INPUT_TEXT_SOURCES) {
      const value = context.getNamespace(source.namespace)?.[source.field];

      if (typeof value === 'string' && value.trim().length > 0) {
        return value;
      }
    }

    return null;
  }

  /**
   * Resuelve la instruccion: plantilla de la base de datos o texto en linea.
   *
   * `templatePromptId` tiene PRIORIDAD sobre `inlinePrompt` cuando vienen los
   * dos. Es la eleccion mas conservadora: la plantilla es un activo compartido y
   * revisado, y el texto en linea suele ser un resto de una prueba anterior.
   */
  private async resolvePrompt(
    config: ResolvedLlmExtractorConfig,
  ): Promise<PromptResolution> {
    if (config.templatePromptId !== null) {
      try {
        const template = await this.aiPromptTemplatesService.findOneEntity(
          config.templatePromptId,
        );

        return { prompt: template.promptText };
      } catch (error) {
        // `findOneEntity` lanza `NotFoundException`, que el motor clasificaria
        // como fallo de dominio GRAVE por ser una `HttpException`. Se traduce
        // aqui de todos modos para nombrar el `code` propio del nodo: un
        // `catchErrors` del esquema no puede enrutar sobre ERR_NODE_HTTP_FAILURE,
        // que es el cajon comun de todas las estrategias.
        return {
          failure: {
            level: 'GRAVE',
            code: ERR_LLM_PROMPT_UNRESOLVED,
            message: `No se pudo recuperar la plantilla de prompt "${config.templatePromptId}": ${
              error instanceof Error ? error.message : String(error)
            }`,
            missingFields: ['templatePromptId'],
            ...stackTraceOf(error),
          },
        };
      }
    }

    if (config.inlinePrompt !== null && config.inlinePrompt.trim().length > 0) {
      return { prompt: config.inlinePrompt };
    }

    // El DTO admite que falten los dos para que una plantilla de flujo pueda
    // declarar este nodo sin operativa. Ejecutarlo asi no tiene sentido, y el
    // fallo se nombra AQUI en vez de mandar una cadena vacia al proveedor, que
    // facturaria una inferencia sobre ninguna instruccion.
    return {
      failure: {
        level: 'GRAVE',
        code: ERR_LLM_PROMPT_UNRESOLVED,
        message:
          'El nodo procesador de IA no tiene instruccion: elige una plantilla de prompt o escribe una en el asistente antes de activar el flujo.',
        missingFields: ['templatePromptId', 'inlinePrompt'],
      },
    };
  }

  /**
   * Interpola los marcadores del prompt contra el contexto acumulado.
   *
   * `getInterpolatedValue` LANZA si la ruta no resuelve, de modo que la
   * excepcion se captura aqui y se traduce a GRAVE: dejarla salir la
   * normalizaria el motor a URGENTE, que `canRetry` nunca reintenta y que el
   * operador no puede corregir desde el flujo PAUSADO.
   */
  private interpolate(
    context: StatePayloadContext,
    prompt: string,
  ): { readonly prompt: string } | { readonly failure: NodeErrorDetail } {
    try {
      return { prompt: context.getInterpolatedValue(prompt) };
    } catch (error) {
      if (error instanceof MissingContextVariableException) {
        return {
          failure: {
            level: 'GRAVE',
            code: ERR_LLM_INTERPOLATION,
            message: `No se pudo resolver el prompt contra el contexto: ${error.message}`,
            missingFields: [error.variable],
            ...stackTraceOf(error),
          },
        };
      }

      // Imprevisto de verdad: que lo normalice el motor a URGENTE.
      throw error;
    }
  }

  /**
   * Elige el cliente, o `null` si el proveedor no tiene uno implementado.
   *
   * `dryRun` gana a `provider`: es el interruptor explicito de coste cero, y un
   * operador que lo activa esta diciendo "no gastes", no "gasta si el proveedor
   * configurado es de pago".
   *
   * ANTHROPIC y OPENAI devuelven `null` y NO caen al simulador. La tentacion es
   * evidente —"al menos el flujo termina"— y es justo lo que no debe pasar: la
   * salida simulada seguiria hasta el `MAPEADOR_PLANTILLA`, que la publicaria en
   * Drupal como si fuera una redaccion real. Un fallo ruidoso es infinitamente
   * preferible a una noticia inventada en produccion.
   */
  private resolveProvider(
    config: ResolvedLlmExtractorConfig,
  ): ILlmProviderClient | null {
    if (config.dryRun || config.provider === LlmProvider.MOCK) {
      return this.mockProvider;
    }

    if (config.provider === LlmProvider.GEMINI) {
      return this.geminiProvider;
    }

    return null;
  }

  /**
   * Clave del freno: aisla el contador por ejecucion Y por nodo.
   *
   * El cursor del contexto es el `nodeId` que se esta ejecutando, asi que dos
   * nodos de IA distintos dentro del mismo flujo cuentan por separado. Es lo
   * correcto: uno puede apuntar a un proveedor caido y el otro a uno sano.
   */
  private buildBrakeKey(context: StatePayloadContext): string {
    return `${context.getExecutionId()}:${context.getCursor()}`;
  }

  /**
   * Contabiliza un fallo del proveedor y decide si activar el freno.
   *
   * Por debajo del umbral devuelve GRAVE, que el motor SI reintenta: un corte
   * puntual no debe pausar un flujo. Al alcanzarlo devuelve URGENTE, que
   * `canRetry` rechaza, de modo que la ejecucion queda PAUSADA conservando el
   * cursor —reanudable con CU-09 en cuanto el proveedor vuelva.
   *
   * Se DEVUELVE URGENTE en lugar de lanzar. La diferencia no es de estilo: una
   * excepcion la clasificaria `toDomainFailure` como catastrofica y marcaria la
   * ejecucion FALLIDO, terminal, obligando a relanzar el flujo desde cero
   * cuando el trabajo de los nodos anteriores sigue siendo perfectamente valido.
   */
  private registerFailure(
    brakeKey: string,
    config: ResolvedLlmExtractorConfig,
    error: unknown,
  ): NodeResult {
    const failures = (this.consecutiveFailures.get(brakeKey) ?? 0) + 1;
    const description = error instanceof Error ? error.message : String(error);

    if (failures >= config.emergencyBrakeThreshold) {
      // La entrada se borra tambien aqui: la ejecucion queda pausada y su clave
      // no volvera a consultarse hasta que CU-09 la reanude, momento en el que
      // el contador debe empezar limpio.
      this.consecutiveFailures.delete(brakeKey);

      this.logger.error(
        `URGENTE | ${ERR_LLM_EMERGENCY_BRAKE} | ${brakeKey} | Freno activado tras ${failures} fallos consecutivos: ${description}`,
      );

      return {
        success: false,
        error: {
          level: 'URGENTE',
          code: ERR_LLM_EMERGENCY_BRAKE,
          message:
            'Freno de emergencia activado: proveedor LLM no responde tras reintentos consecutivos. Flujo pausado para prevenir sobrecostes.',
          ...stackTraceOf(error),
        },
      };
    }

    this.consecutiveFailures.set(brakeKey, failures);

    this.logger.warn(
      `GRAVE | ${brakeKey} | Fallo ${failures}/${config.emergencyBrakeThreshold} del proveedor ${config.provider}: ${description}`,
    );

    return {
      success: false,
      error: {
        level: 'GRAVE',
        code: ERR_LLM_PROVIDER_FAILURE,
        message: `El proveedor ${config.provider} no completo la inferencia: ${description}`,
        ...stackTraceOf(error),
      },
    };
  }
}
