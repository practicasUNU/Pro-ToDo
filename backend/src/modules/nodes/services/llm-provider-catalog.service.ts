import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  LLM_PREVIEW_LENGTH,
  LlmModelDescriptor,
  LlmTestConnectionResponseDto,
} from '@modules/nodes/dto/llm-catalog.dto';
import {
  LlmProvider,
  LlmProviderException,
} from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import { UserRole } from '@modules/users/enums/user-role.enum';
import { LlmProviderFactory } from '@modules/nodes/strategies/llm-provider.factory';
import { ANTHROPIC_API_KEY_VAR } from '@modules/nodes/strategies/providers/anthropic-llm.provider';
import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_API_KEY_VAR,
} from '@modules/nodes/strategies/providers/gemini-llm.provider';
import { MOCK_LLM_MODEL } from '@modules/nodes/strategies/providers/mock-llm.provider';
import { AiCallStatus } from '@modules/telemetry/enums/ai-call-status.enum';
import { TelemetryOperationOrigin } from '@modules/telemetry/enums/telemetry-origin.enum';
import { TelemetryService } from '@modules/telemetry/telemetry.service';

import type { LlmTestConnectionDto } from '@modules/nodes/dto/llm-catalog.dto';
import type { LlmTokenUsage } from '@modules/nodes/strategies/interfaces/llm-provider.interface';

/**
 * Credencial que habilita a cada proveedor, por nombre de variable.
 *
 * Se reutilizan las constantes que ya exportan los propios clientes en vez de
 * reescribir los literales: si manana `AnthropicLlmProvider` cambia de
 * variable, el catalogo no puede quedarse diciendo que esta configurada.
 *
 * `MOCK` no aparece: no necesita credencial. `OPENAI` tampoco, porque sin
 * cliente la credencial es irrelevante — `hasClient` ya lo descarta antes.
 */
const PROVIDER_CREDENTIAL_VARS: Partial<Record<LlmProvider, string>> = {
  [LlmProvider.ANTHROPIC]: ANTHROPIC_API_KEY_VAR,
  [LlmProvider.GEMINI]: GEMINI_API_KEY_VAR,
};

/** Un modelo del catalogo antes de calcularle la disponibilidad. */
type CuratedModel = Omit<LlmModelDescriptor, 'isAvailable'>;

/**
 * Tabla curada de modelos.
 *
 * Es una lista escrita a mano, y conviene decirlo en vez de disimularlo: lo
 * que esta tarea elimina no es el mantenimiento de la lista, sino que viviera
 * en el frontend, donde no se puede saber si una credencial esta presente. El
 * dato que de verdad cambia sin desplegar —`isAvailable`— se calcula en cada
 * peticion.
 *
 * El orden importa: dentro de cada proveedor van de mas capaz a mas barato,
 * que es como se lee un selector.
 */
const CURATED_MODELS: readonly CuratedModel[] = [
  {
    provider: LlmProvider.ANTHROPIC,
    model: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    isTestOnly: false,
    supportsVision: true,
    contextWindow: 1_000_000,
    minRoleRequired: UserRole.ADMIN,
  },
  {
    provider: LlmProvider.ANTHROPIC,
    model: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    isTestOnly: false,
    supportsVision: true,
    contextWindow: 1_000_000,
    minRoleRequired: UserRole.ADMIN,
  },
  {
    provider: LlmProvider.ANTHROPIC,
    model: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    isTestOnly: false,
    supportsVision: true,
    contextWindow: 200_000,
    minRoleRequired: UserRole.ADMIN,
  },
  // Los dos relevos de la gama 1.5, retirada de `v1beta` por Google. Citar un
  // modelo que ya no se sirve no da un error de validacion sino un 404 de ruta
  // —el identificador viaja en el PATH—, asi que el catalogo tiene que
  // envejecer con la API. Limites tomados de `GET /v1beta/models`.
  {
    provider: LlmProvider.GEMINI,
    model: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    isTestOnly: false,
    supportsVision: true,
    contextWindow: 1_048_576,
    // Releva a `gemini-1.5-pro` en el puesto de gama alta reservada a ADMIN. Se
    // prefiere a `gemini-3.1-pro-preview` porque un modelo en preview puede
    // renombrarse sin aviso, que es como se llego hasta aqui.
    minRoleRequired: UserRole.ADMIN,
  },
  {
    provider: LlmProvider.GEMINI,
    model: DEFAULT_GEMINI_MODEL,
    label: 'Gemini 3.6 Flash',
    isTestOnly: false,
    supportsVision: true,
    contextWindow: 1_048_576,
  },
  {
    // Se lista aunque no tenga cliente, y no es un descuido: el enum lo admite
    // y un operador puede encontrarselo en un flujo heredado. Verlo marcado
    // como no disponible explica por que su salida sale simulada; omitirlo
    // dejaria el mismo sintoma sin ninguna pista.
    provider: LlmProvider.OPENAI,
    model: 'gpt-4o',
    label: 'OpenAI GPT-4o',
    isTestOnly: false,
    supportsVision: true,
    contextWindow: 128_000,
    minRoleRequired: UserRole.ADMIN,
  },
  {
    provider: LlmProvider.MOCK,
    model: MOCK_LLM_MODEL,
    label: 'Simulador determinista (coste cero)',
    isTestOnly: true,
    // El simulador acepta adjuntos y describe cuantos recibio, asi que la ruta
    // de vision del parser se puede ensayar entera sin gastar un euro.
    supportsVision: true,
    contextWindow: 0,
  },
];

/**
 * Modelos cuyo uso exige rol ADMIN, derivados de la tabla curada.
 *
 * Se DERIVA y no se escribe aparte: dos listas se desincronizan en cuanto
 * alguien anade un modelo a una sola de ellas, y el sintoma seria un modelo de
 * pago que nadie bloquea.
 *
 * Es una constante de modulo y no un metodo del servicio A PROPOSITO. La
 * consume `WorkflowsService`, y `WorkflowsModule` evita deliberadamente
 * importar `NodesModule` (ver su docblock); inyectar el servicio obligaria a
 * acoplarlos. Importar una constante pura es justo lo que ya hace
 * `WizardModule` con los DTOs de este modulo.
 */
export const ADMIN_ONLY_MODELS: ReadonlySet<string> = new Set(
  CURATED_MODELS.filter(
    (curated) => curated.minRoleRequired === UserRole.ADMIN,
  ).map((curated) => curated.model),
);

/**
 * Instruccion fija de la prueba de conectividad.
 *
 * Constante y minima a proposito: la prueba mide credencial y red, no calidad
 * de redaccion, y un prompt variable convertiria cada pulsacion del boton en
 * un coste distinto e imprevisible.
 */
const PING_PROMPT =
  'Responde con una sola frase corta confirmando que la conexion funciona.';

/**
 * Espera maxima de la prueba.
 *
 * Mas corta que la del nodo (15 s por defecto) porque al otro lado hay una
 * persona mirando un boton girar, no un flujo en segundo plano.
 */
const TEST_CONNECTION_TIMEOUT_MS = 8_000;

/**
 * Aviso que acompana a la respuesta cuando la prueba se hizo pero su consumo
 * no quedo registrado. Se devuelve en vez de callarlo: la inferencia ya se
 * facturo, y el informe de consumo no la va a mostrar.
 */
export const TELEMETRY_NOT_RECORDED_WARNING =
  'La prueba se realizó, pero no se pudo registrar su consumo en el informe de IA.';

/**
 * Catalogo de modelos de lenguaje y banco de pruebas de conectividad.
 *
 * Existe para que el asistente deje de adivinar. Hasta ahora el formulario del
 * nodo `PROCESADOR_IA` recorria un enum replicado en el frontend y pedia el
 * modelo como texto libre, de modo que elegir un proveedor sin credencial no
 * daba ningun error: la ejecucion degradaba al simulador y eso solo se
 * descubria auditando `metadata.isMock` despues de que el flujo hubiera
 * corrido.
 */
@Injectable()
export class LlmProviderCatalogService {
  private readonly logger = new Logger(LlmProviderCatalogService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly providerFactory: LlmProviderFactory,
    private readonly telemetryService: TelemetryService,
  ) {}

  /**
   * Catalogo completo, con la disponibilidad resuelta contra el entorno ACTUAL.
   *
   * Se recalcula en cada llamada en vez de memorizarse: una clave anadida al
   * `.env` tras un reinicio debe notarse al recargar el asistente, no al
   * siguiente despliegue. El coste es leer un par de variables de proceso.
   */
  public getAvailableModels(): LlmModelDescriptor[] {
    return CURATED_MODELS.map((curated) => ({
      ...curated,
      isAvailable: this.isProviderUsable(curated.provider),
    }));
  }

  /**
   * Ejecuta una inferencia minima contra el proveedor y mide cuanto tarda.
   *
   * NUNCA LANZA. Un fallo de conexion es un resultado legitimo de esta
   * operacion —es, de hecho, lo que se esta midiendo—, asi que viaja como
   * `success: false` dentro de un 200. Mismo criterio que las comprobaciones
   * del asistente (`WizardService.checkImap`): el 4xx queda para un cuerpo mal
   * formado, que es lo unico que el cliente puede corregir reintentando.
   */
  public async testConnection(
    dto: LlmTestConnectionDto,
    userId: string,
  ): Promise<LlmTestConnectionResponseDto> {
    // Guarda temprana: sin cliente no hay nada que probar, y pedirselo a la
    // factoria devolveria el simulador. Una prueba que responde "correcto"
    // porque simulo la respuesta es peor que no tener boton.
    if (!this.providerFactory.hasClient(dto.provider)) {
      return {
        success: false,
        latencyMs: 0,
        isMock: false,
        outputPreview: '',
        error: {
          level: 'GRAVE',
          message: `El proveedor "${dto.provider}" todavia no tiene cliente implementado. Un nodo configurado asi no fallara: degradara al simulador y su salida saldra marcada con isMock.`,
        },
      };
    }

    const client = this.providerFactory.getClient(dto.provider);
    // `Date.now()` y no `performance.now()`: es como mide el resto del backend
    // (`metrics.elapsedMs` del scraper), y la resolucion de milisegundos sobra
    // para una llamada de red.
    const startedAt = Date.now();

    try {
      const payload = await client.generateCompletion(PING_PROMPT, undefined, {
        model: dto.model,
        timeoutMs: TEST_CONNECTION_TIMEOUT_MS,
        // CERO reintentos, al contrario que en ejecucion. Una prueba que
        // reintenta sola miente sobre la latencia que acaba de medir y
        // multiplica por cuatro el coste de pulsar el boton.
        maxRetries: 0,
      });

      const latencyMs = Date.now() - startedAt;

      this.logger.log(
        `Prueba de conectividad ${dto.provider}/${dto.model}: ${latencyMs} ms${
          payload.metadata.isMock ? ' (simulada)' : ''
        }`,
      );

      // Una respuesta simulada no cuesta nada ni dice nada del proveedor: no
      // se registra, igual que las inferencias del simulador en un flujo.
      const recorded = payload.metadata.isMock
        ? true
        : await this.recordUsage(dto, userId, {
            modelUsed: payload.metadata.modelUsed || dto.model,
            tokensPrompt: payload.metadata.tokensPrompt,
            tokensCompletion: payload.metadata.tokensCompletion,
            tokensReasoning: payload.metadata.tokensReasoning ?? 0,
            usageReported: payload.metadata.usageReported ?? true,
          });

      return {
        success: true,
        latencyMs,
        isMock: payload.metadata.isMock,
        outputPreview: this.buildPreview(payload.headline, payload.summary),
        ...(recorded
          ? {}
          : { telemetryWarning: TELEMETRY_NOT_RECORDED_WARNING }),
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);

      this.logger.warn(
        `Prueba de conectividad fallida ${dto.provider}/${dto.model} tras ${latencyMs} ms: ${message}`,
      );

      // El fallo de la API tambien cuenta para la tasa del modelo. Si el
      // proveedor llego a responder (contrato roto, respuesta truncada) su
      // consumo viaja en la excepcion; si no, la fila va con ceros.
      const recorded =
        dto.provider === LlmProvider.MOCK
          ? true
          : await this.recordUsage(
              dto,
              userId,
              (error instanceof LlmProviderException
                ? error.usage
                : undefined) ?? {
                modelUsed: dto.model,
                tokensPrompt: 0,
                tokensCompletion: 0,
                tokensReasoning: 0,
                usageReported: false,
              },
              message,
            );

      return {
        success: false,
        latencyMs,
        isMock: false,
        outputPreview: '',
        error: { level: 'GRAVE', message: this.translateFailure(message) },
        ...(recorded
          ? {}
          : { telemetryWarning: TELEMETRY_NOT_RECORDED_WARNING }),
      };
    }
  }

  /**
   * Registra la prueba en la telemetria con origen `PROBAR_CONEXION`.
   *
   * Best-effort y sin lanzar, como el resto de esta operacion: la prueba ya se
   * hizo y su resultado es lo que el usuario espera ver. Devuelve `false` si no
   * se pudo escribir, para que la respuesta lo avise en lugar de callarlo.
   *
   * @param errorMessage Mensaje de la API si la llamada fallo; `null` si fue bien.
   */
  private async recordUsage(
    dto: LlmTestConnectionDto,
    userId: string,
    usage: LlmTokenUsage,
    errorMessage: string | null = null,
  ): Promise<boolean> {
    try {
      await this.telemetryService.recordAssistUsage({
        userId,
        origin: TelemetryOperationOrigin.CONNECTION_TEST,
        status:
          errorMessage === null ? AiCallStatus.SUCCESS : AiCallStatus.FAILED,
        errorMessage,
        aiProvider: dto.provider,
        aiModel: usage.modelUsed || dto.model,
        promptTokens: usage.tokensPrompt,
        completionTokens: usage.tokensCompletion,
        reasoningTokens: usage.tokensReasoning,
        usageReported: usage.usageReported,
      });

      return true;
    } catch (error) {
      this.logger.error(
        `No se pudo registrar el consumo de la prueba de conectividad ${dto.provider}/${dto.model} (usuario ${userId}): ${error instanceof Error ? error.message : String(error)}`,
      );

      return false;
    }
  }

  /**
   * Un proveedor es usable si tiene cliente Y su credencial esta en el entorno.
   *
   * Las dos condiciones hacen falta: un cliente sin clave no falla, degrada al
   * simulador, que para quien rellena el formulario es tan inservible como no
   * tener cliente.
   */
  public isProviderUsable(provider: LlmProvider): boolean {
    if (!this.providerFactory.hasClient(provider)) {
      return false;
    }

    const credentialVar = PROVIDER_CREDENTIAL_VARS[provider];

    // Sin variable asociada la credencial no aplica: es el caso del simulador.
    if (credentialVar === undefined) {
      return true;
    }

    const value = this.configService.get<string>(credentialVar)?.trim();

    return value !== undefined && value.length > 0;
  }

  /**
   * Muestra de lo que redacto el modelo.
   *
   * Se prefiere el titular y se cae al resumen: un modelo que respeto el
   * contrato deja algo en el primero, y uno que no, al menos suele dejar algo
   * en el segundo. La muestra se recorta porque es para confirmar de un
   * vistazo que hubo respuesta, no para leerla.
   */
  private buildPreview(headline: string, summary: string): string {
    const text = headline.trim().length > 0 ? headline : summary;

    return text.length > LLM_PREVIEW_LENGTH
      ? `${text.slice(0, LLM_PREVIEW_LENGTH)}…`
      : text;
  }

  /**
   * Antepone una pista accionable a los fallos que tienen una causa conocida.
   *
   * El mensaje original se conserva siempre detras: adivinar mal la causa y
   * ocultar el texto real dejaria a quien depura sin nada. Los codigos vienen
   * de `HttpClientService`, que ya tradujo el error de Axios antes de que el
   * cliente del proveedor lo envolviera en su excepcion.
   */
  private translateFailure(message: string): string {
    if (message.includes('ERR_HTTP_CLIENT_REJECTED')) {
      return `El proveedor rechazo la peticion: revisa que la credencial sea valida y que el modelo exista para esa cuenta. Detalle: ${message}`;
    }

    if (message.includes('ERR_NODE_HTTP_TIMEOUT')) {
      return `El proveedor no respondio dentro de los ${TEST_CONNECTION_TIMEOUT_MS} ms de la prueba. Detalle: ${message}`;
    }

    if (message.includes('ERR_HTTP_UPSTREAM_UNAVAILABLE')) {
      return `No se pudo contactar con el proveedor, o respondio con un error de su lado. Detalle: ${message}`;
    }

    return message;
  }
}
