import { Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import {
  DEFAULT_PARSER_SOURCE_NAMESPACE,
  ParserEmailConfigDto,
  resolveParserEmailConfig,
} from '@modules/nodes/dto/parser-email-config.dto';
import { buildParsedEmail } from '@modules/nodes/utils/parsed-email-payload.util';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type {
  INodeStrategy,
  NodeErrorDetail,
  NodeOutputField,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';
import type { ResolvedParserEmailConfig } from '@modules/nodes/dto/parser-email-config.dto';
import type { ValidatorOptions } from 'class-validator';

/**
 * Codigos de fallo del nodo. Son lo que un `catchErrors` puede mencionar.
 *
 * Ya no hay `ERR_PARSER_SOURCE_MISSING`: la ausencia del namespace de origen la
 * detecta ahora el motor ANTES de invocar al nodo, mediante
 * `getRequiredNamespaces`, y la emite como `ERR_MISSING_UPSTREAM_CONTEXT`. Un
 * esquema cuyo `catchErrors` mencionase el codigo antiguo debe actualizarse.
 */
export const ERR_PARSER_CONFIG = 'ERR_PARSER_CONFIG';

/**
 * Opciones de validacion canonicas del repositorio (ver `PipelineValidatorService`).
 */
const VALIDATION_OPTIONS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

/** Union discriminada: o hay configuracion, o hay un fallo que devolver. */
type ParserConfigResolution =
  | { readonly config: ResolvedParserEmailConfig }
  | { readonly failure: NodeErrorDetail };

/**
 * Nodo PARSER_PRE_IA: sanea el correo crudo, extrae sus enlaces de contenido y
 * decide si el pipeline puede seguir con texto o necesita un modelo con vision.
 *
 * Su razon de existir es la ECONOMIA DE TOKENS (RNF-01): el `PROCESADOR_IA` no
 * debe pagar por etiquetas, hojas de estilo, hilos citados, firmas ni avisos
 * legales.
 *
 * ESTA CLASE ES SOLO EL CONTRATO DEL NODO: validacion de `params`, guarda de
 * precondicion y traduccion de fallos a `NodeResult`. La limpieza de texto vive
 * en `email-sanitizer.util` y la composicion del payload en
 * `parsed-email-payload.util`, ambas funciones puras. No es una separacion
 * cosmetica: `WizardService` consume `buildParsedEmail` para el banco de pruebas
 * del asistente, y que haya UNA sola implementacion es lo que garantiza que lo
 * que el operador ve al probar sea exactamente lo que producira este nodo.
 *
 * NODO PURO: no escribe en el contexto ni toca namespaces ajenos. Devuelve
 * `data` y es `FsmEngineService` quien la deposita en el `outputNamespace`. En
 * particular NO libera el base64 de `raw_email`: esa es competencia exclusiva
 * del motor. El unico enlace entre ambos son dos nombres de clave que el motor
 * reconoce —`clean_body`, que declara "ya hay texto", y
 * `requires_multimodal_fallback`, que veta la liberacion porque el binario sigue
 * siendo la unica fuente de datos—; el parser no sabe nada de la purga.
 *
 * TODOS los fallos son GRAVE: solo los GRAVE entran en la politica de reintentos
 * de `FsmEngineService.canRetry`, y tanto una configuracion mal escrita como un
 * namespace de origen ausente son corregibles por el operador con el flujo
 * PAUSADO (CU-09).
 */
@Injectable()
export class ParserEmailStrategy implements INodeStrategy {
  public readonly nodeType = NodeType.PARSER_PRE_IA;

  /**
   * Las trece claves que `buildParsedEmail` deposita en el namespace del nodo.
   *
   * El ORDEN y los nombres replican `ParsedEmailPayload`
   * (`parsed-email-payload.util.ts`), que es quien las construye. Declararlas
   * aqui es lo que permite al asistente ofrecer `{{parsed_email.campo}}` en un
   * selector cerrado sin que el frontend replique la forma del payload.
   *
   * `extracted_urls` es el unico `url[]`: es el arreglo del que el EXTRACTOR_WEB
   * toma una POSICION, y por eso el selector de aquel nodo lo despliega en
   * entradas indexadas mientras que a los demas campos ni los mira.
   */
  public readonly outputFields: readonly NodeOutputField[] = [
    {
      name: 'subject',
      type: 'text',
      description: 'Asunto original del correo',
    },
    { name: 'clean_title', type: 'text', description: 'Titular saneado' },
    { name: 'clean_body', type: 'text', description: 'Cuerpo sin marcado' },
    { name: 'body_source', type: 'text', description: 'Origen del cuerpo' },
    { name: 'character_count', type: 'number' },
    { name: 'original_character_count', type: 'number' },
    { name: 'reduction_percentage', type: 'number' },
    {
      name: 'extracted_urls',
      type: 'url[]',
      description: 'Enlaces de contenido del correo',
    },
    { name: 'attachment_count', type: 'number' },
    { name: 'attachments', type: 'object' },
    { name: 'extracted_documents_text', type: 'text' },
    { name: 'requires_multimodal_fallback', type: 'boolean' },
    { name: 'multimodal_reason', type: 'text' },
  ];

  private readonly logger = new Logger(ParserEmailStrategy.name);

  public async execute(
    context: StatePayloadContext,
    params: Record<string, unknown>,
  ): Promise<NodeResult> {
    const resolution = await this.resolveConfig(params);

    if ('failure' in resolution) {
      return { success: false, error: resolution.failure };
    }

    const { config } = resolution;

    // Sin guarda de precondicion sobre el namespace: la garantiza el motor, que
    // no llega a invocar este metodo si `getRequiredNamespaces` no se satisface.
    // El `?? {}` cubre el unico hueco que queda —una invocacion directa fuera
    // del motor, como la del banco de pruebas— sin volver a duplicar el
    // diagnostico.
    const source = context.getNamespace(config.sourceNamespace) ?? {};

    // Los avisos de la composicion se enchufan al logger del nodo. El asistente
    // enchufa los mismos hooks a su respuesta HTTP, que es lo que permite que el
    // banco de pruebas muestre lo que aqui solo llega al archivo `.log`.
    const parsed = await buildParsedEmail(source, config, {
      // El mensaje NO promete "se continua sin cuerpo": desde que los enlaces se
      // leen del marcado aunque el cuerpo venga del texto plano, este aviso
      // puede dispararse con el cuerpo perfectamente intacto y solo los enlaces
      // perdidos.
      onSanitizeFailure: (reason) =>
        this.logger.warn(
          `No se pudo sanear el marcado del correo: ${reason}. Se continua con lo que si pudo procesarse.`,
        ),
      onMultimodalFallback: (reason) => this.logger.log(reason),
      // LEVE y no bloqueante, igual que los descartes de `ImapTriggerStrategy`:
      // un adjunto ilegible no puede tumbar la ejecucion del flujo entero.
      onDocumentFailure: (filename, reason) =>
        this.logger.warn(
          `LEVE | No se pudo extraer texto del adjunto "${filename}": ${reason}. Se continua sin el.`,
        ),
      // Tampoco bloquea: un correo sin enlaces es legitimo. El aviso existe
      // porque `EXTRACTOR_WEB` se quedara sin nada que escrapear y, sin esta
      // linea, el operador solo veria un arreglo vacio sin explicacion.
      onNoUrlsFound: () =>
        this.logger.warn(
          'LEVE | El marcado del correo no declaraba ningun enlace aprovechable: "extracted_urls" queda vacio.',
        ),
    });

    return { success: true, data: { ...parsed } };
  }

  /**
   * Namespace del que este nodo lee el correo crudo.
   *
   * Se deriva de `params` y no de una constante porque `sourceNamespace` es
   * configurable: el defecto es `raw_email`, pero un flujo puede apuntar el
   * parser a otro namespace de la lista cerrada, y declararlo fijo rechazaria
   * esa configuracion perfectamente valida.
   *
   * Si `params` viene mal formado se devuelve el defecto en vez de lanzar: la
   * validacion del DTO es competencia de `execute`, y adelantarla aqui daria dos
   * mensajes distintos para el mismo error.
   */
  public getRequiredNamespaces(
    params: Record<string, unknown>,
  ): readonly string[] {
    const sourceNamespace =
      typeof params.sourceNamespace === 'string' &&
      params.sourceNamespace.length > 0
        ? params.sourceNamespace
        : DEFAULT_PARSER_SOURCE_NAMESPACE;

    return [sourceNamespace];
  }

  /**
   * Valida `params` y aplica los valores por defecto.
   *
   * Se usa `validate` y NO `validateOrReject`: esta ultima lanza, y el motor
   * normaliza toda excepcion a URGENTE, que `canRetry` nunca reintenta.
   */
  private async resolveConfig(
    params: Record<string, unknown>,
  ): Promise<ParserConfigResolution> {
    const dto = plainToInstance(ParserEmailConfigDto, params);
    const errors = await validate(dto, VALIDATION_OPTIONS);

    if (errors.length > 0) {
      const invalidFields = errors.map((error) => error.property);
      const constraints = errors.flatMap((error) =>
        Object.values(error.constraints ?? {}),
      );

      return {
        failure: {
          level: 'GRAVE',
          code: ERR_PARSER_CONFIG,
          message: `Configuracion invalida del nodo parser: ${constraints.join(' ')}`,
          missingFields: invalidFields,
        },
      };
    }

    return { config: resolveParserEmailConfig(dto) };
  }
}
