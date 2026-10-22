import { Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  MissingContextVariableException,
  extractNamespaceRoots,
} from '@core/fsm/context/state-payload.context';
import { AiDefaultsConfig } from '@core/config/ai-defaults.config';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { AiPromptTemplatesService } from '@modules/ai-prompt-templates/ai-prompt-templates.service';
import {
  DEFAULT_LLM_MARKUP_MAX_TOKENS,
  LlmExtractorConfigDto,
  resolveLlmExtractorConfig,
} from '@modules/nodes/dto/llm-extractor-config.dto';
import {
  LlmProvider,
  LlmProviderException,
} from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import { LlmProviderFactory } from '@modules/nodes/strategies/llm-provider.factory';
import { LlmProviderCatalogService } from '@modules/nodes/services/llm-provider-catalog.service';
import {
  buildProviderAttempts,
  isFallbackWorthy,
} from '@modules/nodes/strategies/provider-fallback';
import { MockLlmProvider } from '@modules/nodes/strategies/providers/mock-llm.provider';
import {
  recordFailedCallUsage,
  recordResponseUsage,
  toUsageMetadata,
} from '@modules/nodes/strategies/inference-telemetry';
import { TelemetryService } from '@modules/telemetry/telemetry.service';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type { PromptReference } from '@core/fsm/types/prompt-text-resolver.port';
import type {
  INodeStrategy,
  NodeErrorDetail,
  NodeOutputField,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';
import type { ResolvedLlmExtractorConfig } from '@modules/nodes/dto/llm-extractor-config.dto';
import type { ProviderAttempt } from '@modules/nodes/strategies/provider-fallback';
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
/**
 * @deprecated Ya no se emite: desde los defaults por entorno, un proveedor sin
 * cliente degrada al simulador con un aviso en vez de fallar (ver
 * `resolveProvider`). Se conserva exportado porque puede figurar en el
 * `catchErrors` de esquemas ya guardados, y retirarlo dejaria esas rutas
 * apuntando a una constante inexistente.
 */
export const ERR_LLM_PROVIDER_UNSUPPORTED = 'ERR_LLM_PROVIDER_UNSUPPORTED';
/**
 * RETIRADO como salida de la estrategia: lo sustituye
 * `ERR_LLM_MAX_RETRIES_EXCEEDED`. Se conserva exportado por el mismo motivo que
 * el de arriba —un `catchErrors` de un esquema ya guardado puede nombrarlo—,
 * pero ninguna ruta nueva deberia usarlo: este nodo ya no lo emite, de modo que
 * una ruta que solo lo atrape no se disparara nunca.
 */
export const ERR_LLM_PROVIDER_FAILURE = 'ERR_LLM_PROVIDER_FAILURE';
/**
 * El nodo agoto su propio presupuesto de reintentos contra el proveedor.
 *
 * Sustituye a `ERR_LLM_PROVIDER_FAILURE` desde que el fallo viaja con
 * `metadata.exhausted`: aquel describia "un intento no salio" y este, "ya se
 * intento todo lo que este nodo sabe intentar". La diferencia la lee el motor,
 * que no vuelve a reintentar encima, y tambien el operador, al que un reintento
 * manual inmediato no le va a servir de nada.
 */
export const ERR_LLM_MAX_RETRIES_EXCEEDED = 'ERR_LLM_MAX_RETRIES_EXCEEDED';
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
  'filled_markup',
  'metadata',
] as const;

/** Opciones de validacion canonicas del repositorio. */
const VALIDATION_OPTIONS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

/**
 * Origenes del texto a procesar, EN ORDEN DE PRESENTACION.
 *
 * YA NO ES UNA CASCADA EXCLUYENTE. Hasta PROT-21 esta lista se recorria
 * devolviendo el primer origen con contenido, y eso descartaba en silencio todo
 * lo demas: un correo con cuerpo Y adjuntos ofimaticos mandaba al modelo solo el
 * cuerpo, aunque el dato que el operador buscaba estuviese en el adjunto. Ahora
 * se acumulan todos los que aporten algo, cada uno bajo su etiqueta, y el orden
 * de esta lista es el orden en que aparecen en la materia prima.
 *
 * El rescate por OCR va PRIMERO: si existe, es porque el parser no encontro
 * texto aprovechable y el nodo de transcripcion lo recupero de los adjuntos.
 * Dejarlo detras haria que un `clean_body` residual del parser —el "Ver
 * adjunto" que a veces acompana a un escaneo— encabezase la transcripcion real.
 *
 * `label` es lo que encabeza cada bloque, en espanol porque lo lee el modelo (y
 * el operador cuando audita la ejecucion), no el codigo.
 */
const INPUT_TEXT_SOURCES = [
  { namespace: 'ocr_result', field: 'clean_body', label: 'Transcripcion OCR' },
  { namespace: 'parsed_email', field: 'clean_body', label: 'Correo' },
  {
    namespace: 'parsed_email',
    field: 'extracted_documents_text',
    label: 'Documentos adjuntos',
  },
  {
    namespace: 'scraped_web',
    field: 'full_article_content',
    label: 'Articulo original',
  },
] as const;

/**
 * Materia prima cuando TODOS los bloques ya viajan dentro de la instruccion.
 *
 * Pasa con plantillas como `VERIFICADOR_TITULOS_DEFAULT`, que interpola el unico origen
 * poblado. Mandar el `prompt` vacio dejaria al proveedor una peticion sin
 * contenido —algunos la rechazan— y al operador un log ilegible; esta linea dice
 * explicitamente donde esta el material.
 */
export const MATERIAL_IN_INSTRUCTIONS_NOTICE =
  'El material a procesar figura integro en las instrucciones.';

/**
 * Marcador `{{namespace.campo}}` de un origen concreto.
 *
 * Misma gramatica que `StatePayloadContext.getInterpolatedValue`
 * (`architecture-patterns.md` §3), espacios interiores incluidos, para que lo
 * que aqui se detecta como "ya interpolado" y lo que alli se sustituye no
 * discrepen. Sustitucion determinista: ni AST ni evaluacion dinamica
 * (`security-and-scope.md` §3).
 */
const markerPattern = (namespace: string, field: string): RegExp =>
  new RegExp(`\\{\\{\\s*${namespace}\\.${field}\\s*\\}\\}`);

/**
 * Marcador de una plantilla base, venga del namespace que venga.
 *
 * DELIBERADAMENTE NO usa `markerPattern('rendered_html', 'compiled_markup')`.
 * El `outputNamespace` es una propiedad del NODO en el `pipeline_schema`, no de
 * su tipo: `rendered_html` es solo el valor que el asistente propone por
 * defecto, y la regla 4 del validador de topologia admite cualquier entrada de
 * `NODE_OUTPUT_NAMESPACES`. Atar la deteccion al literal significaria que un
 * MAPEADOR_PLANTILLA reconfigurado deja de recibir la directiva de maquetado
 * —en silencio, porque el prompt se interpolaria igual de bien— y el escudo
 * posterior acabaria culpando a la IA de no devolver markup que nunca se le
 * pidio.
 *
 * Lo que identifica a una plantilla base es el CAMPO, `compiled_markup`, que es
 * la clave que publica `TemplateMapperStrategy` y nadie mas.
 *
 * `[a-z0-9_]+` replica `OUTPUT_NAMESPACE_PATTERN`, de modo que no reconoce como
 * namespace nada que el motor no pudiera resolver.
 */
const BASE_TEMPLATE_MARKER_PATTERN =
  /\{\{\s*[a-z0-9_]+\.compiled_markup\s*\}\}/;

/** Union discriminada: o hay configuracion, o hay un fallo que devolver. */
type LlmConfigResolution =
  | { readonly config: ResolvedLlmExtractorConfig }
  | { readonly failure: NodeErrorDetail };

/** Union discriminada del prompt ya resuelto contra la base de datos. */
type PromptResolution =
  { readonly prompt: string } | { readonly failure: NodeErrorDetail };

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
      name: 'filled_markup',
      type: 'text',
      description:
        'La plantilla base devuelta ya rellena, o null si el prompt no cito ninguna',
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
    private readonly providerFactory: LlmProviderFactory,
    private readonly aiDefaults: AiDefaultsConfig,
    // Responde si un proveedor tiene cliente Y credencial. Hasta ahora este
    // nodo no lo preguntaba: llamaba al configurado y, si fallaba, se rendia.
    private readonly providerCatalog: LlmProviderCatalogService,
    // Registra cada inferencia facturada en `telemetria_tokens_ia`.
    private readonly telemetryService: TelemetryService,
  ) {}

  public async execute(
    context: StatePayloadContext,
    params: Record<string, unknown>,
  ): Promise<NodeResult> {
    const resolution = await this.resolveConfig(params);

    if ('failure' in resolution) {
      return { success: false, error: resolution.failure };
    }

    const brakeKey = this.buildBrakeKey(context);

    const config = this.applyEnvironmentDefaults(resolution.config, params);

    // Guarda de CONTENIDO. Va antes de resolver el prompt porque es la mas
    // barata de las dos —mira el contexto que ya esta en memoria— y porque sin
    // texto de entrada no hay inferencia que preparar, tenga o no plantilla.
    // Solo comprueba que EXISTA material; ensamblarlo viene despues, porque el
    // ensamblado depende de que cite el prompt.
    //
    // Ya no hay excepcion por adjuntos: el correo cuyo unico contenido es un PDF
    // escaneado lo atiende ahora el nodo PROCESADOR_OCR, que publica su
    // transcripcion en `ocr_result` y la deja como primer origen de esta lista.
    if (!this.hasAnyInputText(context)) {
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

    // La materia prima se ensambla AQUI y no en la guarda de arriba porque
    // necesita el prompt SIN interpolar: es lo unico que permite saber que
    // origenes ya viajan dentro de la instruccion y no hay que repetir.
    const inputText = this.buildInputText(context, promptResolution.prompt);

    // Deteccion de plantilla base. Se hace sobre el prompt RESUELTO pero SIN
    // INTERPOLAR, y el orden no es negociable: `getInterpolatedValue` sustituye
    // el marcador por el HTML, de modo que despues de interpolar ya no queda
    // nada que detectar. Cubre las tres vias del prompt —`inlinePrompt`,
    // `promptCode` y `templatePromptId`—, que es mas de lo que alcanza
    // `getRequiredNamespaces`: aquel es puro y sincrono por contrato y solo ve
    // el prompt en linea, mientras que aqui el texto guardado ya esta resuelto.
    const expectsFilledMarkup = BASE_TEMPLATE_MARKER_PATTERN.test(
      promptResolution.prompt,
    );

    this.warnOnOrphanAttachments(context);

    const interpolated = this.interpolate(context, promptResolution.prompt);

    if ('failure' in interpolated) {
      this.consecutiveFailures.delete(brakeKey);

      return { success: false, error: interpolated.failure };
    }

    const attempts = this.resolveAttempts(config);

    let response: LlmResponsePayload | undefined;
    let usedProvider = config.provider;
    let lastError: unknown;

    // Bucle de RESILIENCIA ACTIVA, hermano del que corre el nodo de OCR: ante
    // un proveedor saturado (429 de cuota) o caido (5xx) se prueba el
    // siguiente en vez de rendirse. El freno de emergencia NO se mueve aqui
    // dentro: un fallo del que se salio con otro proveedor no es un proveedor
    // que no responde, y contarlo por intento activaria el freno —umbral 3—
    // dentro de una sola ejecucion del nodo.
    for (const [index, attempt] of attempts.entries()) {
      try {
        // El TEXTO va como prompt y la INSTRUCCION como systemPrompt, y no al
        // reves. El motivo es que asi el contenido llega al modelo aunque la
        // instruccion del operador no incluya ningun marcador que lo interpole:
        // un prompt como "resume esto en tres parrafos" es perfectamente valido
        // y no menciona ningun namespace. Con el reparto contrario, ese prompt
        // facturaria una inferencia sobre ningun contenido.
        const maxTokens = this.resolveMaxTokens(config, expectsFilledMarkup);

        response = await this.resolveClient(
          attempt.provider,
          config.dryRun,
        ).generateCompletion(inputText, interpolated.prompt, {
          model: attempt.model,
          timeoutMs: config.timeoutMs,
          maxRetries: config.maxRetries,
          baseDelayMs: config.baseDelayMs,
          expectsFilledMarkup,
          // Se OMITE cuando no hay nada que decir, en vez de mandar un numero:
          // asi el defecto lo sigue publicando cada proveedor, que es como ha
          // funcionado hasta hoy. Ver `resolveMaxTokens`.
          ...(maxTokens === null ? {} : { maxTokens }),
        });

        usedProvider = attempt.provider;
        break;
      } catch (error) {
        lastError = error;

        // Una respuesta truncada o con el contrato roto se factura igual: se
        // registra ANTES de decidir si se prueba otro proveedor o se pausa.
        const telemetryFailure = await recordFailedCallUsage(
          this.telemetryService,
          context,
          attempt.provider,
          error,
        );

        if (telemetryFailure !== null) {
          return { success: false, error: telemetryFailure };
        }

        const code =
          error instanceof LlmProviderException ? error.code : undefined;
        const next = attempts[index + 1];

        if (!isFallbackWorthy(code) || next === undefined) {
          return this.registerFailure(brakeKey, config, error);
        }

        this.logger.warn(
          `${attempt.provider} no pudo completar la inferencia (${code}): ` +
            `se reintenta con ${next.provider} y ${next.model}.`,
        );
      }
    }

    // Defensivo: el bucle solo sale por `break` o por `return`.
    if (response === undefined) {
      return this.registerFailure(brakeKey, config, lastError);
    }

    // Exito: el contador se reinicia. El freno cuenta fallos CONSECUTIVOS, y una
    // inferencia correcta demuestra que el proveedor responde; conservar los
    // fallos anteriores frenaria mas tarde por una racha que ya se rompio.
    this.consecutiveFailures.delete(brakeKey);

    // El consumo se persiste ANTES de publicar el exito: si no se puede dejar
    // constancia del gasto, el flujo se pausa en lugar de seguir a ciegas.
    const usage = await recordResponseUsage(
      this.telemetryService,
      context,
      usedProvider,
      response.metadata,
    );

    if ('failure' in usage) {
      return { success: false, error: usage.failure };
    }

    const filledMarkup = this.normalizeMarkup(response.filled_markup);

    // Aviso, no fallo: quien decide es el ESCUDO_POST_IA, que para eso existe.
    // Pero sin esta linea el primer indicio de que el modelo ignoro la plantilla
    // llega un nodo mas tarde, como un ERR_POST_IA_EMPTY_HTML que no dice nada
    // del proveedor ni del modelo que lo provocaron. Solo se emite cuando el
    // markup se PIDIO: sin plantilla, un `null` aqui es lo esperado.
    if (expectsFilledMarkup && filledMarkup === null) {
      this.logger.warn(
        `GRAVE | ${brakeKey} | ${usedProvider} no devolvio filled_markup pese a ` +
          'haberse suministrado una plantilla base; el escudo posterior lo rechazara.',
      );
    }

    return {
      success: true,
      data: {
        headline: response.headline,
        summary: response.summary,
        body_paragraphs: response.body_paragraphs,
        // La clave se publica SIEMPRE, tambien cuando no hay plantilla: un
        // namespace cuyas claves cambian segun la configuracion obligaria a
        // cada consumidor a comprobar la existencia antes de interpolar. `null`
        // es ademas lo que `PostIaSanitizerStrategy` lee como
        // ERR_POST_IA_EMPTY_HTML, que es el diagnostico correcto.
        filled_markup: filledMarkup,
        metadata: {
          ...response.metadata,
          provider: usedProvider,
          model: response.metadata.modelUsed,
          // tokensPrompt, tokensCompletion, tokensReasoning, totalTokens y
          // estimatedCostUSD: lo mismo que quedo en `telemetria_tokens_ia`.
          ...toUsageMetadata(usage.metrics),
          // Solo cuando respondio OTRO: sin esta marca, una redaccion pagada en
          // Anthropic seria indistinguible de una gratuita en Gemini al
          // auditar la ejecucion.
          ...(usedProvider === config.provider
            ? {}
            : { fallbackFrom: config.provider }),
        },
      },
    };
  }

  /**
   * Namespaces que el prompt en linea necesita para resolverse.
   *
   * Se derivan con el MISMO extractor que alimenta la interpolacion real, de
   * modo que lo que aqui se exige y lo que alli se resuelve no discrepen.
   *
   * DEVUELVE VACIO con `templatePromptId` o `promptCode`, y es inevitable: el
   * texto de la plantilla vive en `plantillas_prompts_ia` y leerlo seria I/O,
   * mientras que
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
   * Prompt guardado que este nodo cita, si cita alguno.
   *
   * Es la mitad que `getRequiredNamespaces` no puede cubrir. Aquel solo ve
   * `inlinePrompt`, porque es puro y sincrono y el texto de una plantilla vive
   * en `plantillas_prompts_ia`; sin esto, un flujo que resuelve su instruccion
   * por codigo parece no depender de ningun namespace, y un
   * `{{scraped_web.full_article_content}}` dentro de ese prompt —como el que
   * trae `NOTIWEB_DEFAULT`— no se detectaba hasta reventar en ejecucion.
   *
   * MISMA PRECEDENCIA QUE `resolvePrompt`: `templatePromptId` gana a
   * `promptCode`. Devolver las dos referencias cuando ambas estan declaradas
   * haria que el validador exigiera los namespaces de un prompt que la ejecucion
   * nunca va a leer.
   *
   * `inlinePrompt` no entra: su texto esta en los `params` y ya lo analiza
   * `getRequiredNamespaces`.
   */
  public getPromptReferences(
    params: Record<string, unknown>,
  ): readonly PromptReference[] {
    const { templatePromptId, promptCode } = params;

    if (
      typeof templatePromptId === 'string' &&
      templatePromptId.trim() !== ''
    ) {
      return [{ kind: 'id', value: templatePromptId.trim() }];
    }

    if (typeof promptCode === 'string' && promptCode.trim() !== '') {
      return [{ kind: 'code', value: promptCode.trim() }];
    }

    return [];
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
    const hasCode =
      typeof params.promptCode === 'string' &&
      params.promptCode.trim().length > 0;
    const hasInline =
      typeof params.inlinePrompt === 'string' &&
      params.inlinePrompt.trim().length > 0;

    return hasTemplate || hasCode || hasInline
      ? []
      : ['templatePromptId | promptCode | inlinePrompt'];
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

    const config = resolveLlmExtractorConfig(
      dto,
      this.aiDefaults.getTextHttpDefaults(),
    );

    // La politica de red EFECTIVA, una vez cruzado lo que guarda el nodo con lo
    // que impone el entorno. Va en `debug` y no en `log` porque corre una vez
    // por ejecucion y solo interesa cuando se esta diagnosticando justo esto —
    // pero cuando se esta, es la unica forma de distinguir "el `.env` no se
    // aplico" de "el `.env` se aplico y aun asi no basta", que desde fuera dan
    // el mismo ERR_HTTP_TIMEOUT.
    this.logger.debug(
      `[Inferencia LLM] Timeout efectivo: ${config.timeoutMs}ms | ` +
        `Reintentos: ${config.maxRetries} | ` +
        `Espera base: ${config.baseDelayMs}ms`,
    );

    return { config };
  }

  /**
   * Valor util de un origen, o `null` si no aporta nada.
   *
   * Una cadena de solo espacios cuenta como ausencia: mandarla al modelo
   * facturaria tokens por procesar nada.
   */
  private readSource(
    context: StatePayloadContext,
    namespace: string,
    field: string,
  ): string | null {
    const value = context.getNamespace(namespace)?.[field];

    return typeof value === 'string' && value.trim().length > 0 ? value : null;
  }

  /**
   * ¿Hay algun origen con contenido?
   *
   * Alimenta la GUARDA temprana de `execute`, que corre antes de resolver el
   * prompt por ser la comprobacion mas barata: mira el contexto que ya esta en
   * memoria y evita un viaje a `plantillas_prompts_ia` cuando no hay nada que
   * procesar. El ensamblado real es `buildInputText`, y necesita el texto del
   * prompt, que en ese punto todavia no se ha leido.
   */
  private hasAnyInputText(context: StatePayloadContext): boolean {
    return INPUT_TEXT_SOURCES.some(
      (source) =>
        this.readSource(context, source.namespace, source.field) !== null,
    );
  }

  /**
   * Materia prima: todos los origenes con contenido, etiquetados y en orden.
   *
   * OMITE el origen que el prompt YA cita como marcador. Sin esta regla, una
   * plantilla como `LICITACION_APERTURA_DEFAULT` —que interpola `clean_body` y
   * `extracted_documents_text`— mandaria ambos textos dos veces, duplicando los
   * tokens de cada llamada sin aportar un solo dato nuevo. La comprobacion va
   * contra el prompt SIN interpolar, que es donde el marcador todavia existe.
   *
   * Si no sobrevive ningun bloque, el material esta integro en la instruccion y
   * se devuelve `MATERIAL_IN_INSTRUCTIONS_NOTICE` en lugar de una cadena vacia.
   */
  private buildInputText(
    context: StatePayloadContext,
    rawPrompt: string,
  ): string {
    const blocks: { readonly label: string; readonly value: string }[] = [];

    for (const source of INPUT_TEXT_SOURCES) {
      const value = this.readSource(context, source.namespace, source.field);

      if (value === null) {
        continue;
      }

      if (markerPattern(source.namespace, source.field).test(rawPrompt)) {
        continue;
      }

      blocks.push({ label: source.label, value });
    }

    if (blocks.length === 0) {
      return MATERIAL_IN_INSTRUCTIONS_NOTICE;
    }

    // UN SOLO BLOQUE VA SIN ETIQUETA. La cabecera existe para que el modelo
    // sepa que esta leyendo dos cosas distintas; con una sola fuente no separa
    // nada y si estorba: encabeza el texto con una linea que no es del material
    // —y el simulador, que titula con la primera linea, acabaria devolviendo
    // "Correo:" como titular—.
    const [only] = blocks;

    if (blocks.length === 1 && only !== undefined) {
      return only.value;
    }

    return blocks
      .map((block) => `${block.label}:\n${block.value}`)
      .join('\n\n');
  }

  /**
   * Avisa de adjuntos que no han dejado texto en ninguna parte.
   *
   * NO falla el nodo, y es deliberado: un adjunto puede ser un PDF escaneado sin
   * capa de texto, que es exactamente el caso que `PROCESADOR_OCR` existe para
   * atender. Convertirlo en GRAVE pausaria flujos correctos. Lo que se corrige
   * es la ceguera: hasta ahora ese correo se procesaba como si no hubiera
   * llevado adjunto alguno y no quedaba rastro de ello en ningun sitio.
   */
  private warnOnOrphanAttachments(context: StatePayloadContext): void {
    const attachmentCount =
      context.getNamespace('parsed_email')?.attachment_count;

    if (typeof attachmentCount !== 'number' || attachmentCount <= 0) {
      return;
    }

    const hasDocumentsText =
      this.readSource(context, 'parsed_email', 'extracted_documents_text') !==
      null;
    const hasOcrRescue =
      this.readSource(context, 'ocr_result', 'clean_body') !== null;

    if (hasDocumentsText || hasOcrRescue) {
      return;
    }

    this.logger.warn(
      `La ejecucion ${context.getExecutionId()} declara ${attachmentCount} adjunto(s) ` +
        'pero ninguno ha aportado texto: el modelo procesara el correo sin ellos. ' +
        'Si son documentos escaneados, encadena un nodo PROCESADOR_OCR antes de este.',
    );
  }

  /**
   * Resuelve la instruccion: plantilla de la base de datos o texto en linea.
   *
   * PRECEDENCIA: `templatePromptId` > `promptCode` > `inlinePrompt`.
   *
   * Las dos plantillas van antes que el texto en linea por la eleccion mas
   * conservadora: la plantilla es un activo compartido y revisado, y el texto
   * en linea suele ser un resto de una prueba anterior. Entre las dos gana el
   * UUID por ser la referencia mas especifica —apunta a UNA fila concreta—
   * mientras que el codigo es la forma portable de nombrar la misma plantilla.
   * En la practica declarar ambos es un error de configuracion; lo que importa
   * es que el desempate sea estable y este escrito.
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

    if (config.promptCode !== null) {
      try {
        const template = await this.aiPromptTemplatesService.findByCode(
          config.promptCode,
        );

        return { prompt: template.promptText };
      } catch (error) {
        // Misma traduccion que la rama del UUID, y por el mismo motivo: sin
        // ella el fallo subiria como ERR_NODE_HTTP_FAILURE, el cajon comun de
        // todas las estrategias, sobre el que un `catchErrors` del esquema no
        // puede enrutar.
        return {
          failure: {
            level: 'GRAVE',
            code: ERR_LLM_PROMPT_UNRESOLVED,
            message: `No se pudo recuperar la plantilla de prompt con codigo "${config.promptCode}": ${
              error instanceof Error ? error.message : String(error)
            }`,
            missingFields: ['promptCode'],
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
        missingFields: ['templatePromptId', 'promptCode', 'inlinePrompt'],
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
   * Elige el cliente que ejecutara la inferencia.
   *
   * `dryRun` gana a `provider`: es el interruptor explicito de coste cero, y un
   * operador que lo activa esta diciendo "no gastes", no "gasta si el proveedor
   * configurado es de pago".
   *
   * OPENAI —el unico que queda sin cliente— DEGRADA al simulador con un aviso,
   * en lugar de devolver `null` y fallar con `ERR_LLM_PROVIDER_UNSUPPORTED`
   * como hacia antes. El
   * cambio llega con los defaults por entorno: `AI_DEFAULT_PROVIDER` puede
   * nombrar un proveedor todavia sin cliente, y con el comportamiento anterior
   * cualquier nodo que no declarase el suyo habria pasado a fallar de golpe
   * —incluidos los flujos ya guardados que hoy corren sobre el defecto MOCK.
   *
   * RIESGO QUE ESTO ACEPTA, y conviene tenerlo escrito: una redaccion simulada
   * puede ahora llegar al `MAPEADOR_PLANTILLA` y de ahi a un destino real. Lo
   * unico que la distingue es `metadata.isMock`, que viaja en el namespace y
   * queda en la traza de la ejecucion. Quien publique a produccion deberia
   * mirarlo; la alternativa —fallar— tiene el coste simetrico de pausar flujos
   * sanos por una variable de entorno que mira al futuro.
   *
   * Es ademas el mismo criterio que aplican `GeminiLlmProvider` y
   * `AnthropicLlmProvider` cuando falta su clave de API: degradar con aviso y
   * marcar la salida, no reventar. Que el proveedor tenga cliente registrado
   * aqui no garantiza, por tanto, una inferencia real; `metadata.isMock` sigue
   * siendo la unica senal fiable.
   */
  /**
   * Presupuesto de tokens de la respuesta, o `null` para dejar mandar al proveedor.
   *
   * Tres escalones, de mayor a menor precedencia: lo que declare el nodo, el
   * tope de marcado cuando toca devolver una plantilla, y el defecto del
   * proveedor.
   *
   * EL TERCER ESCALON ES `null` Y NO UN NUMERO, A PROPOSITO. Fijar aqui un tope
   * para las inferencias SIN plantilla no seria conservador, seria un cambio de
   * conducta: hoy este nodo no envia `maxTokens` en absoluto, de modo que
   * Anthropic aplica su propio tope de 4096 y Gemini el del modelo. Cualquier
   * cifra que se escribiera aqui por debajo de eso recortaria en silencio
   * flujos que llevan meses redactando articulos largos sin problema, y el
   * sintoma —una noticia cortada a media frase— no se parece en nada a su causa.
   * Subir el presupuesto cuando hace falta es seguro; bajarlo no.
   */
  private resolveMaxTokens(
    config: ResolvedLlmExtractorConfig,
    expectsFilledMarkup: boolean,
  ): number | null {
    if (config.maxTokens !== null) {
      return config.maxTokens;
    }

    return expectsFilledMarkup ? DEFAULT_LLM_MARKUP_MAX_TOKENS : null;
  }

  /**
   * Normaliza el marcado del proveedor a lo que se publica en el namespace.
   *
   * El cliente devuelve `undefined` cuando el modelo no emitio la clave; aqui se
   * convierte en `null` porque es un valor del contexto, y `undefined` no
   * sobrevive a una serializacion JSON —el contexto se persiste como `jsonb` en
   * el checkpoint, y la clave desapareceria al releerla.
   */
  private normalizeMarkup(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();

    return trimmed.length > 0 ? trimmed : null;
  }

  private resolveClient(
    provider: LlmProvider,
    dryRun: boolean,
  ): ILlmProviderClient {
    // La guarda de coste cero se queda AQUI y no en la factoria: es una
    // decision del nodo sobre su propia configuracion, no una propiedad del
    // proveedor. El resto del mapeo lo resuelve la factoria, que es la unica
    // que conoce que clientes existen.
    if (dryRun || provider === LlmProvider.MOCK) {
      return this.mockProvider;
    }

    return this.providerFactory.getClient(provider);
  }

  /**
   * Proveedores a los que llamar, en orden. Gemelo del que usa el nodo de OCR.
   *
   * Simular no es un fallo del que recuperarse, asi que `dryRun` y `MOCK` dan
   * un unico intento. Sin ningun proveedor usable se conserva el configurado
   * para que `resolveClient` degrade al simulador con aviso, que es el
   * comportamiento documentado de este nodo; lo que el respaldo NO hace nunca
   * es recoger con el simulador un fallo de ejecucion.
   */
  private resolveAttempts(
    config: ResolvedLlmExtractorConfig,
  ): readonly ProviderAttempt[] {
    const configured: ProviderAttempt = {
      provider: config.provider,
      model: config.model,
    };

    if (config.dryRun || config.provider === LlmProvider.MOCK) {
      return [configured];
    }

    const attempts = buildProviderAttempts(configured, (provider) =>
      this.providerCatalog.isProviderUsable(provider),
    );

    return attempts.length === 0 ? [configured] : attempts;
  }

  /**
   * Completa proveedor y modelo con los defaults del entorno.
   *
   * PRECEDENCIA, de mas fuerte a mas debil: los `params` del nodo, el par del
   * `.env` que corresponda al modo, y las constantes del DTO. El nodo manda
   * siempre: quien configuro un `provider` concreto tomo una decision que una
   * variable de entorno no debe revocar a sus espaldas.
   *
   * DOS PARES Y NO UNO porque redactar y leer un escaneado son trabajos
   * distintos: el modelo bueno escribiendo no tiene por que ser el bueno —ni el
   * barato— haciendo OCR, y con una sola variable elegir uno obligaba a aceptar
   * el otro.
   *
   * `dryRun` no se toca aqui: es el interruptor explicito de coste cero y lo
   * resuelve `resolveProvider`, que tiene la ultima palabra sobre el cliente.
   *
   * El proveedor del entorno se valida contra el enum antes de aplicarlo. Llega
   * como cadena porque `AiDefaultsConfig` vive en `@core` y no puede importar el
   * enum de `@modules`; un valor que no case se ignora, y `AiDefaultsConfig` ya
   * dejo el aviso en el log.
   *
   * SE MIRAN LOS `params` CRUDOS y no la configuracion resuelta. La razon es que
   * `resolveLlmExtractorConfig` ya aplico los defectos, de modo que a esa altura
   * no queda rastro de si el valor lo eligio el nodo o lo puso la constante.
   * Comparar contra la constante casi funciona, y falla justo donde importa: un
   * nodo que declara `provider: MOCK` —el mismo valor que el defecto— habria
   * pasado por no haber declarado nada, y el entorno le habria cambiado el
   * proveedor a sus espaldas.
   */
  private applyEnvironmentDefaults(
    config: ResolvedLlmExtractorConfig,
    params: Record<string, unknown>,
  ): ResolvedLlmExtractorConfig {
    const declaresProvider = this.declaresParam(params.provider);
    const declaresModel = this.declaresParam(params.model);

    // Si el nodo declaro las dos cosas no hay nada que completar, y ni siquiera
    // se lee el entorno.
    if (declaresProvider && declaresModel) {
      return config;
    }

    // Siempre el par de TEXTO: la transcripcion es trabajo del nodo
    // PROCESADOR_OCR, que lee `AI_OCR_DEFAULT_*` por su cuenta.
    const defaults = this.aiDefaults.getTextDefaults();

    const envProvider = this.toProvider(defaults.provider);

    return {
      ...config,
      provider: declaresProvider
        ? config.provider
        : (envProvider ?? config.provider),
      model: declaresModel ? config.model : (defaults.model ?? config.model),
    };
  }

  /** El nodo escribio este `param` de verdad, con un valor no vacio. */
  private declaresParam(value: unknown): boolean {
    return typeof value === 'string' && value.trim().length > 0;
  }

  /** Cadena del entorno a valor del enum, o `null` si no corresponde a ninguno. */
  private toProvider(value: string | null): LlmProvider | null {
    if (value === null) {
      return null;
    }

    return Object.values(LlmProvider).includes(value as LlmProvider)
      ? (value as LlmProvider)
      : null;
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
   * Por debajo del umbral devuelve GRAVE con `metadata.exhausted`, de modo que
   * el motor NO reintenta encima: cuando se llega aqui ya corrieron los
   * reintentos del transporte HTTP (`maxRetries` por intento) y la cascada de
   * proveedores entera. Sumar los del `retryPolicy` del nodo multiplicaria las
   * llamadas al modelo —y el gasto— por una incidencia que ya se sabe
   * persistente, con una alerta por cada vuelta. Sigue siendo GRAVE y no
   * URGENTE porque la ejecucion queda PAUSADA y reanudable con CU-09 en cuanto
   * el proveedor vuelva.
   *
   * Al alcanzar el umbral de fallos CONSECUTIVOS devuelve URGENTE: eso ya no
   * describe un corte, sino un proveedor que lleva varias ejecuciones sin
   * responder.
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
      `GRAVE | ${ERR_LLM_MAX_RETRIES_EXCEEDED} | ${brakeKey} | Fallo ${failures}/${config.emergencyBrakeThreshold} del proveedor ${config.provider} tras agotar ${config.maxRetries} reintentos: ${description}`,
    );

    return {
      success: false,
      error: {
        level: 'GRAVE',
        code: ERR_LLM_MAX_RETRIES_EXCEEDED,
        message: `Inferencia fallida tras agotar ${config.maxRetries} reintentos`,
        description: `Se realizaron ${config.maxRetries} reintentos contra el modelo ${config.model} del proveedor ${config.provider}. Causa raiz: ${description}`,
        metadata: {
          attempts: config.maxRetries,
          maxRetries: config.maxRetries,
          exhausted: true,
          lastError: description,
        },
        ...stackTraceOf(error),
      },
    };
  }
}
