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
 * El correo no trae texto aprovechable: solo imagen o PDF escaneado.
 *
 * NO se emite por defecto. El nodo senala ese caso con la bandera
 * `requires_multimodal_fallback` y deja seguir el flujo; solo lo convierte en
 * fallo cuando `params.failOnUnextractableMedia` es `true`, que es como el
 * disenador del flujo declara que ahi hay una bifurcacion que atender.
 *
 * Es el codigo que un `catchErrors` menciona para desviar a un nodo de alerta o
 * a uno de vision. Que sea un fallo DECLARADO y no la bandera a secas es lo que
 * lo hace enrutable: `onErrorStep` solo se consulta en la rama de fallo del
 * motor, y un nodo que devuelve exito nunca llega a ella.
 */
export const ERR_PARSER_UNEXTRACTABLE_MEDIA = 'ERR_PARSER_UNEXTRACTABLE_MEDIA';

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
      // Tampoco bloquea ni degrada nada: hay texto y es el bueno. El aviso
      // existe porque el adjunto traia MAS de lo que se extrajo, y el operador
      // tiene que poder enterarse sin abrir el fichero.
      onDocumentNotice: (filename, notice) =>
        this.logger.warn(`LEVE | Adjunto "${filename}": ${notice}`),
      // Tampoco bloquea: un correo sin enlaces es legitimo. El aviso existe
      // porque `EXTRACTOR_WEB` se quedara sin nada que escrapear y, sin esta
      // linea, el operador solo veria un arreglo vacio sin explicacion.
      onNoUrlsFound: () =>
        this.logger.warn(
          'LEVE | El marcado del correo no declaraba ningun enlace aprovechable: "extracted_urls" queda vacio.',
        ),
    });

    // --- Bifurcacion declarada. El payload viaja TAMBIEN en el fallo: el motor
    // no lo publicara en `parsed_email` —un nodo que falla no escribe su
    // namespace— pero lo traslada a `error_context.partial_data`, y de ahi lo
    // lee el nodo de respaldo. Sin el, un nodo de vision tendria que volver a
    // deducir del correo crudo el inventario de adjuntos que aqui ya esta
    // resuelto, y una alerta no podria citar el `multimodal_reason`.
    //
    // GRAVE, como el resto de fallos de este nodo: es el unico nivel que entra
    // en la politica de reintentos del motor, y sobre todo el unico que deja la
    // ejecucion PAUSADA y reanudable si el esquema no declara ninguna ruta. Un
    // flujo que bifurque por aqui deberia declarar `retryPolicy: { maxRetries:
    // 0 }`: el fallo es determinista sobre el mismo correo, asi que reintentarlo
    // solo retrasa el desvio.
    if (
      config.failOnUnextractableMedia &&
      parsed.requires_multimodal_fallback
    ) {
      this.logger.warn(
        `GRAVE | ${ERR_PARSER_UNEXTRACTABLE_MEDIA} | ${parsed.multimodal_reason}`,
      );

      return {
        success: false,
        data: { ...parsed },
        error: {
          level: 'GRAVE',
          code: ERR_PARSER_UNEXTRACTABLE_MEDIA,
          message: parsed.multimodal_reason,
        },
      };
    }

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
   * `ERR_PARSER_UNEXTRACTABLE_MEDIA` es inalcanzable sin el interruptor puesto.
   *
   * Es la otra mitad de `failOnUnextractableMedia`, y hace falta porque la
   * estrategia NO ve el `onErrorStep` de su nodo: `execute` recibe el contexto y
   * los `params`, nada mas. El unico punto donde el interruptor y la ruta son
   * visibles a la vez es la validacion del esquema, asi que es alli donde se
   * rechaza la combinacion incoherente — declarar la ruta y dejar el interruptor
   * apagado — antes de que el flujo llegue a produccion con un respaldo muerto.
   *
   * Se lee `params` en crudo y no el DTO resuelto porque el metodo es sincrono
   * por contrato y `resolveConfig` es asincrono. La comparacion es estricta
   * contra `true`: `params` viene de una columna jsonb, donde la cadena
   * `"false"` es truthy, y un interruptor que se encendiera solo desactivaria en
   * silencio la unica guarda que protege esta ruta.
   */
  public getUnreachableErrorCodes(
    params: Record<string, unknown>,
  ): readonly string[] {
    return params.failOnUnextractableMedia === true
      ? []
      : [ERR_PARSER_UNEXTRACTABLE_MEDIA];
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
