import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { resolveImapConfig } from '@modules/nodes/dto/imap-trigger-config.dto';
import { createImapClient } from '@modules/nodes/services/imap-client.factory';

import { CHECK_IMAP_SUCCESS_MESSAGE } from './dto/check-imap-response.dto';

import type { ImapTriggerConfigDto } from '@modules/nodes/dto/imap-trigger-config.dto';
import type { CheckImapResponseDto } from './dto/check-imap-response.dto';
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
