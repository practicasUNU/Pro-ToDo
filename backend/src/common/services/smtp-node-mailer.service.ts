import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';

import type { OnModuleDestroy } from '@nestjs/common';
import type { Transporter } from 'nodemailer';

/** Puerto por defecto si `SMTP_NODE_PORT` no esta definido (envio con STARTTLS). */
const DEFAULT_SMTP_PORT = 587;

/** Puerto SMTP implicito de TLS directo: solo en el 465 se conecta ya cifrado. */
const IMPLICIT_TLS_PORT = 465;

/**
 * Conexiones simultaneas del pool.
 *
 * Dos, y no una como en el transporte del OTP, porque aqui el disparador es
 * distinto: los codigos de acceso llegan de uno en uno al ritmo de las personas
 * que inician sesion, mientras que una incidencia de infraestructura pausa
 * varios flujos a la vez y sus alertas salen en rafaga. Sigue siendo un numero
 * bajo a proposito: mas canales en paralelo solo invitan al proveedor a aplicar
 * sus propios limites.
 */
const MAX_SMTP_CONNECTIONS = 2;

/** Mensajes por conexion antes de reciclarla. */
const MAX_MESSAGES_PER_CONNECTION = 100;

/** Remitente de ultimo recurso si no hay `SMTP_NODE_FROM` ni `SMTP_NODE_USER`. */
const FALLBACK_SENDER = 'no-reply@unuware.com';

/**
 * Lo que este servicio lee del acuse de `nodemailer`.
 *
 * Se declara en vez de usar su `SentMessageInfo`, que es `any`: sin esto, cada
 * lectura del acuse seria un acceso sin tipar y el compilador dejaria de avisar
 * de un cambio de forma en la libreria.
 *
 * Los dos arreglos son `unknown[]` porque el driver devuelve cadenas o objetos
 * `Address` segun el servidor responda solo con la direccion o tambien con el
 * nombre. Quien los aplana es `normalizeRecipients`.
 */
interface SentMailAcknowledgement {
  readonly messageId?: unknown;
  readonly accepted?: unknown;
  readonly rejected?: unknown;
}

/** Destinatarios y contenido ya resueltos por la estrategia. */
export interface NodeMailMessage {
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly replyTo?: string;
  readonly subject: string;
  /**
   * Version en texto plano. OBLIGATORIA, tambien cuando viaja el HTML.
   *
   * No es cortesia con clientes antiguos: es lo que hace legible el aviso en un
   * reloj, en la notificacion del movil y en un cliente con el marcado
   * bloqueado, que es una configuracion corriente en correo corporativo.
   */
  readonly text: string;
  /**
   * Carta HTML que GENERA EL SISTEMA. Opcional; si falta, sale solo el texto.
   *
   * Ver el TSDoc de la clase: lo que esta prohibido es el marcado que aporta el
   * operador, no el que compone el propio backend con datos escapados.
   */
  readonly html?: string;
}

/** Lo que el proveedor confirma de un envio, para la trazabilidad del nodo. */
export interface NodeMailReceipt {
  readonly messageId: string;
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
}

/**
 * Transporte SMTP de los NODOS del motor, separado del de autenticacion.
 *
 * Es el gemelo de `EmailService`, que atiende al OTP. Existen por separado
 * porque el correo de login y el de una alerta de flujo son dos canales con
 * publicos, volumenes y remitentes distintos: con un unico bloque `SMTP_*`,
 * apuntar las alertas a un buzon de incidencias habria movido tambien el
 * remitente de los codigos de acceso. Este lee EXCLUSIVAMENTE `SMTP_NODE_*`.
 *
 * Que sea un servicio y no logica dentro de `SmtpAlertStrategy` es la misma
 * frontera de siempre: la estrategia decide QUE se dice y a quien, y no sabe
 * nada de pools, de STARTTLS ni de `nodemailer`.
 *
 * EL OPERADOR NO APORTA MARCADO. La regla nacio como "solo texto plano" y sigue
 * vigente en lo que de verdad protegia: ningun campo que el operador escriba en
 * los `params` del nodo llega al buzon como HTML. Su nota se escapa caracter a
 * caracter como cualquier otro dato.
 *
 * Lo que SI viaja como HTML es la carta institucional que compone el propio
 * backend (`buildAlertEmailHtml`), cuya plantilla es fija y cuyos huecos pasan
 * todos por `escapeHtml`. La distincion es la que importa y conviene no
 * deshacerla en la proxima lectura: el peligro nunca fue el HTML, era el HTML de
 * procedencia ajena. Varios datos de esa carta —el mensaje de error del parser,
 * los nombres de los adjuntos— vienen del correo ENTRANTE, que escribe
 * cualquiera; por eso el escapado es obligatorio y no una precaucion.
 *
 * El correo institucional CON PLANTILLA DE USUARIO sigue siendo competencia de
 * `MAPEADOR_PLANTILLA`, que valida su HTML contra la lista de namespaces.
 */
@Injectable()
export class SmtpNodeMailerService implements OnModuleDestroy {
  private readonly logger = new Logger(SmtpNodeMailerService.name);
  private readonly transporter: Transporter;
  private readonly sender: string;

  constructor(private readonly configService: ConfigService) {
    const port =
      this.configService.get<number>('SMTP_NODE_PORT') ?? DEFAULT_SMTP_PORT;
    const user = this.configService.get<string>('SMTP_NODE_USER');
    const password = this.configService.get<string>('SMTP_NODE_PASS');

    this.sender =
      this.configService.get<string>('SMTP_NODE_FROM') ??
      user ??
      FALLBACK_SENDER;

    this.transporter = createTransport({
      host: this.configService.get<string>('SMTP_NODE_HOST'),
      port: Number(port),
      // Solo el 465 habla TLS desde el saludo; el 587 negocia STARTTLS.
      secure: Number(port) === IMPLICIT_TLS_PORT,
      auth: user && password ? { user, pass: password } : undefined,
      pool: true,
      maxConnections: MAX_SMTP_CONNECTIONS,
      maxMessages: MAX_MESSAGES_PER_CONNECTION,
    });
  }

  /**
   * Cierra el pool al apagar la aplicacion. Sin esto, las conexiones abiertas
   * mantienen vivo el bucle de eventos y el proceso no termina.
   */
  public onModuleDestroy(): void {
    this.transporter.close();
  }

  /**
   * Entrega el aviso y devuelve el acuse del proveedor.
   *
   * @throws InternalServerErrorException si el transporte falla. Lanzar, y no
   *         devolver un resultado, es deliberado: quien traduce el fallo al
   *         `NodeResult` del contrato es la estrategia, que es la unica que sabe
   *         con que severidad y con que codigo debe presentarse. Este servicio
   *         no conoce el vocabulario del motor.
   */
  public async sendNodeAlert(
    message: NodeMailMessage,
  ): Promise<NodeMailReceipt> {
    try {
      const info = (await this.transporter.sendMail({
        from: this.sender,
        to: [...message.to],
        ...(message.cc !== undefined && message.cc.length > 0
          ? { cc: [...message.cc] }
          : {}),
        ...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
        subject: message.subject,
        text: message.text,
        // Se omite la clave cuando no hay carta en vez de pasar `undefined`:
        // nodemailer la interpretaria como parte HTML vacia y compondria un
        // multipart con una mitad en blanco.
        ...(message.html !== undefined ? { html: message.html } : {}),
      })) as SentMailAcknowledgement;

      return {
        messageId: this.asText(info.messageId),
        // `accepted`/`rejected` llegan como `(string | Address)[]`: el driver
        // devuelve objetos cuando el servidor responde con el nombre ademas de
        // la direccion. Se normalizan aqui para que el payload del nodo sea
        // siempre un arreglo de cadenas interpolable.
        accepted: this.normalizeRecipients(info.accepted),
        rejected: this.normalizeRecipients(info.rejected),
      };
    } catch (error) {
      // Se registran los destinatarios y el fallo; el cuerpo del aviso no, que
      // puede traer datos del correo original interpolados desde el contexto.
      this.logger.error(
        `No se pudo enviar la alerta del nodo a ${message.to.join(', ')}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException(
        error instanceof Error
          ? `Fallo del transporte SMTP: ${error.message}`
          : 'Fallo desconocido del transporte SMTP.',
      );
    }
  }

  /** Aplana la union `(string | Address)[]` de nodemailer a direcciones. */
  private normalizeRecipients(value: unknown): readonly string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return (value as unknown[]).map((entry) => {
      if (typeof entry === 'string') {
        return entry;
      }

      return typeof entry === 'object' && entry !== null
        ? this.asText((entry as Record<string, unknown>).address)
        : '';
    });
  }

  /**
   * Normaliza a cadena lo que el driver declara sin tipo.
   *
   * Se descarta explicitamente lo que no sea `string` o `number` en vez de
   * llamar a `String()` sobre cualquier cosa: un objeto inesperado se
   * convertiria en el literal `[object Object]`, que acabaria publicado como
   * `message_id` en el namespace del nodo y no significa nada.
   */
  private asText(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }

    return typeof value === 'number' ? String(value) : '';
  }
}
