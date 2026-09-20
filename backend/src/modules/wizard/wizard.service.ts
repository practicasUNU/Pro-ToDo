import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { resolveImapConfig } from '@modules/nodes/dto/imap-trigger-config.dto';
import { resolveParserEmailConfig } from '@modules/nodes/dto/parser-email-config.dto';
import { createImapClient } from '@modules/nodes/services/imap-client.factory';
import { buildParsedEmail } from '@modules/nodes/utils/parsed-email-payload.util';

import { CHECK_IMAP_SUCCESS_MESSAGE } from './dto/check-imap-response.dto';

import type { ImapTriggerConfigDto } from '@modules/nodes/dto/imap-trigger-config.dto';
import type { CheckImapResponseDto } from './dto/check-imap-response.dto';
import type { CheckParserDto } from './dto/check-parser.dto';
import type { CheckParserResponseDto } from './dto/check-parser-response.dto';
import type { ImapFlow } from 'imapflow';

/**
 * Comprobaciones de conectividad del asistente de creacion de flujos.
 *
 * Permite validar las credenciales de un nodo ANTES de guardar el
 * `pipeline_schema`, para que el operador no descubra que el buzon esta mal
 * configurado la primera vez que el sondeo dispare el flujo en produccion. Es
 * la contrapartida servidor del Poka-Yoke de la interfaz.
 *
 * Reutiliza el `ImapTriggerConfigDto` del nodo y `createImapClient` en lugar de
 * declarar su propio contrato: si el asistente validase con reglas distintas de
 * las que aplica la estrategia, una configuracion podria pasar la comprobacion y
 * fallar en la ejecucion, que es justo lo contrario de lo que aporta el paso.
 */
@Injectable()
export class WizardService {
  private readonly logger = new Logger(WizardService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Verifica que las credenciales conectan y que el buzon indicado existe.
   *
   * Comprueba las DOS cosas a proposito: autenticar contra el servidor pero
   * apuntar a un buzon inexistente es un fallo que el operador debe ver aqui, no
   * en la primera ejecucion del flujo. Un `Conexión exitosa` que solo garantice
   * el login seria un falso positivo.
   *
   * NUNCA lanza por un fallo de conexion: el resultado negativo es una respuesta
   * valida del endpoint (200 con `success: false`), no un error de la peticion.
   * Un 4xx/5xx obligaria al cliente a distinguir "el servidor de correo rechazo
   * las credenciales" de "la llamada al backend se rompio".
   */
  public async checkImap(
    imapTriggerConfigDto: ImapTriggerConfigDto,
  ): Promise<CheckImapResponseDto> {
    const config = resolveImapConfig(imapTriggerConfigDto);
    const password = this.configService.get<string>(config.passwordEnvKey);

    // Guarda previa a cualquier socket. Solo se nombra la CLAVE, nunca su valor
    // ni su longitud.
    if (typeof password !== 'string' || password === '') {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          message: `La variable de entorno "${config.passwordEnvKey}" no esta definida o esta vacia en el servidor.`,
        },
      };
    }

    const client = createImapClient(config, password, (error: Error) => {
      this.logger.warn(
        `Error de socket IMAP durante la comprobacion de ${config.host}: ${error.message}`,
      );
    });

    try {
      await client.connect();
      await client.status(config.mailbox, { messages: true });

      this.logger.log(
        `Comprobacion IMAP correcta | host=${config.host}:${config.port} | usuario=${config.user} | buzon=${config.mailbox}`,
      );

      return { success: true, message: CHECK_IMAP_SUCCESS_MESSAGE };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // La traza completa queda en el log del servidor; al cliente solo va el
      // motivo, sin `stackTrace`.
      this.logger.warn(
        `Comprobacion IMAP fallida | host=${config.host}:${config.port} | usuario=${config.user} | buzon=${config.mailbox} | motivo=${message}`,
      );

      return {
        success: false,
        error: {
          // GRAVE y no URGENTE, con la misma escala que usa el nodo: son
          // credenciales o un host corregibles por el operador.
          level: 'GRAVE',
          message: `Fallo la conexion IMAP con ${config.host}:${config.port} (buzon "${config.mailbox}"): ${message}`,
        },
      };
    } finally {
      await this.logoutQuietly(client);
    }
  }

  /**
   * Sanea un correo de prueba con la MISMA logica que ejecutara el nodo.
   *
   * ASINCRONO, aunque aqui no haya ni socket ni red: `buildParsedEmail` extrae
   * el texto nativo de los adjuntos y esa lectura si es asincrona. Lo fue
   * sincrono mientras la composicion no tocaba binarios.
   *
   * Invoca `buildParsedEmail`, que es exactamente la funcion que consume
   * `ParserEmailStrategy`. Esa unicidad es la razon de ser del endpoint: si aqui
   * se reimplementase la cascada o las metricas, divergirian en la primera
   * correccion y el banco de pruebas anunciaria una reduccion que la ejecucion
   * real no produce. Es el mismo criterio por el que `checkImap` reutiliza el
   * DTO del nodo en vez de declarar su propio contrato.
   *
   * Un correo sin texto aprovechable NO es un fallo: se devuelve 200 con
   * `body_source: 'none'`, igual que en produccion. Solo una excepcion
   * inesperada de la composicion produce `success: false`.
   */
  public async checkParser(
    checkParserDto: CheckParserDto,
  ): Promise<CheckParserResponseDto> {
    // `sourceNamespace` no se pasa: el correo viaja en el propio cuerpo y no hay
    // contexto del que leer. El defecto que aplica la funcion es irrelevante
    // aqui, y por eso el DTO de entrada ni siquiera acepta el campo.
    const config = resolveParserEmailConfig({
      minBodyLength: checkParserDto.minBodyLength,
    });
    const warnings: string[] = [];

    // El DTO de entrada NO acepta `contentBase64` a proposito: una ruta del
    // asistente no debe tragarse megabytes. La consecuencia es que aqui la
    // extraccion documental no puede ocurrir, y callarlo dejaria al operador
    // creyendo que un adjunto suyo no aporta texto cuando lo que pasa es que
    // este endpoint nunca lo ha visto.
    if ((checkParserDto.attachments?.length ?? 0) > 0) {
      warnings.push(
        'El banco de pruebas no recibe los binarios de los adjuntos: ' +
          '"extracted_documents_text" sale vacio y la bandera multimodal no es ' +
          'representativa de lo que hara la ejecucion real.',
      );
    }

    // Se reconstruye la FORMA del namespace `raw_email` que deja
    // `ImapTriggerStrategy`, que es lo unico que `buildParsedEmail` sabe leer.
    // Las claves son las mismas que siembra `DEFAULT_MOCK_NAMESPACES`.
    const source: Record<string, unknown> = {
      subject: checkParserDto.subject ?? '',
      text: checkParserDto.text ?? '',
      html: checkParserDto.html ?? '',
      attachments: checkParserDto.attachments ?? [],
    };

    try {
      const parsed = await buildParsedEmail(source, config, {
        onSanitizeFailure: (reason) => {
          this.logger.warn(
            `Banco de pruebas del parser: marcado no saneable (${reason}).`,
          );
          warnings.push(
            `No se pudo sanear el marcado del correo (${reason}). El nodo continuaria con lo que si pudo procesarse.`,
          );
        },
        onMultimodalFallback: (reason) => warnings.push(reason),
        onDocumentFailure: (filename, reason) =>
          warnings.push(
            `No se pudo extraer texto del adjunto "${filename}" (${reason}).`,
          ),
        onNoUrlsFound: () =>
          warnings.push(
            'El marcado del correo no declaraba ningun enlace aprovechable: "extracted_urls" queda vacio y EXTRACTOR_WEB no recibiria nada que escrapear.',
          ),
      });

      // El arreglo se omite cuando esta vacio en vez de enviarse como `[]`: es
      // la unica clave que el asistente anade sobre la ejecucion real, y una
      // lista vacia en cada respuesta seria ruido en el contrato.
      return warnings.length > 0
        ? { success: true, parsed, warnings }
        : { success: true, parsed };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(
        `Fallo inesperado en el banco de pruebas del parser: ${message}`,
      );

      return {
        success: false,
        error: {
          // GRAVE con la misma escala que usa el nodo: es un correo de prueba
          // corregible por el operador, no una averia de la plataforma.
          level: 'GRAVE',
          message: `No se pudo procesar el correo de prueba: ${message}`,
        },
      };
    }
  }

  /** Cierra la sesion sin dejar escapar errores de cierre. */
  private async logoutQuietly(client: ImapFlow): Promise<void> {
    try {
      await client.logout();
    } catch (error) {
      this.logger.warn(
        `No se pudo cerrar la sesion IMAP de la comprobacion: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
