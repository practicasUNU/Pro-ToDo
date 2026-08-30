import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';

import type { OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';

import type { Transporter } from 'nodemailer';

/** Puerto SMTP por defecto si `SMTP_PORT` no esta definido (envio con STARTTLS). */
const DEFAULT_SMTP_PORT = 587;

/** Puerto SMTP implicito de TLS directo: solo en el 465 se conecta ya cifrado. */
const IMPLICIT_TLS_PORT = 465;

/** Conexiones simultaneas del pool. Una basta: se envia un OTP por login. */
const MAX_SMTP_CONNECTIONS = 1;

/** Mensajes por conexion antes de reciclarla. */
const MAX_MESSAGES_PER_CONNECTION = 100;

/** Paleta institucional embebida: los clientes de correo ignoran las hojas externas. */
const BRAND_PRIMARY = '#2C4FC7';
const BRAND_PRIMARY_LIGHT = '#4E74E8';
const BRAND_TEXT = '#12142E';
const BRAND_TEXT_MUTED = '#4A4F6B';
const BRAND_SURFACE = '#EEF1FA';
const BRAND_BORDER = '#D3D8EE';

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/**
 * Unico punto del backend que conoce SMTP. Los servicios de negocio piden "envia
 * este codigo a este correo" y no saben nada del transporte.
 */
@Injectable()
export class EmailService implements OnModuleDestroy {
  private readonly logger = new Logger(EmailService.name);
  private readonly transporter: Transporter;
  private readonly sender: string;

  constructor(private readonly configService: ConfigService) {
    const port =
      this.configService.get<number>('SMTP_PORT') ?? DEFAULT_SMTP_PORT;
    const user = this.configService.get<string>('SMTP_USER');
    const password = this.configService.get<string>('SMTP_PASSWORD');

    this.sender =
      this.configService.get<string>('SMTP_FROM') ??
      user ??
      'no-reply@unuware.com';

    this.transporter = createTransport({
      host: this.configService.get<string>('SMTP_HOST'),
      port: Number(port),
      // Solo el 465 habla TLS desde el saludo; el 587 negocia STARTTLS.
      secure: Number(port) === IMPLICIT_TLS_PORT,
      auth: user && password ? { user, pass: password } : undefined,

      // Conexion persistente: sin pool, cada envio rehace el saludo SMTP, el
      // handshake TLS y la autenticacion, que es de donde salen los segundos de
      // latencia del primer correo. Con el pool esa conexion queda abierta y el
      // segundo envio la reutiliza.
      pool: true,
      // Una sola conexion: el volumen es un OTP por inicio de sesion, y varios
      // canales en paralelo solo invitan al proveedor a aplicar limites.
      maxConnections: MAX_SMTP_CONNECTIONS,
      // Tras 100 mensajes se recicla la conexion, por si el servidor la corta
      // por su cuenta al alcanzar su propio limite.
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
   * Envia el codigo temporal al correo corporativo del usuario.
   *
   * El codigo viaja exclusivamente por este canal: nunca se registra en los logs
   * ni se devuelve en una respuesta HTTP.
   *
   * @throws InternalServerErrorException si el transporte SMTP falla.
   */
  public async sendOtpCode(recipient: string, code: string): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.sender,
        to: recipient,
        subject: 'Proto-Do · Codigo de acceso temporal',
        text: `Tu codigo de acceso es ${code}. Caduca en pocos minutos y solo puede usarse una vez.`,
        html: this.buildOtpTemplate(code),
      });
    } catch (error) {
      // Se registra el destinatario y el fallo, jamas el codigo.
      this.logger.error(
        `No se pudo enviar el codigo OTP a ${recipient}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException(
        'No se pudo enviar el codigo de acceso.',
      );
    }
  }

  /**
   * Plantilla del correo. El codigo es el unico dato dinamico.
   *
   * Todo el CSS va EN LINEA y la maquetacion usa tablas a proposito: Gmail y
   * Outlook descartan las hojas de estilo externas y `<style>` del `<head>`, y su
   * soporte de flex/grid es irregular. Es la unica parte del proyecto exenta de
   * la regla de tokens CSS — los `var(--pd-*)` no existen en un cliente de correo,
   * asi que la paleta se replica como constantes de este archivo.
   */
  private buildOtpTemplate(code: string): string {
    return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND_SURFACE};padding:32px 16px;font-family:${FONT_STACK}">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FFFFFF;border:1px solid ${BRAND_BORDER};border-radius:8px;overflow:hidden">
        <tr>
          <td style="background:linear-gradient(90deg, ${BRAND_PRIMARY} 0%, ${BRAND_PRIMARY_LIGHT} 100%);background-color:${BRAND_PRIMARY};padding:20px 28px">
            <span style="color:#FFFFFF;font-size:15px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase">UNUWARE &middot; Proto-Do</span>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 28px 8px">
            <h1 style="margin:0 0 8px;font-size:20px;line-height:28px;font-weight:700;color:${BRAND_TEXT}">Codigo de acceso</h1>
            <p style="margin:0;font-size:14px;line-height:22px;color:${BRAND_TEXT_MUTED}">
              Usa este codigo para completar tu inicio de sesion.
            </p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:20px 28px">
            <div style="display:inline-block;background:${BRAND_SURFACE};border:1px solid ${BRAND_BORDER};border-radius:8px;padding:16px 28px">
              <span style="font-size:24px;line-height:32px;font-weight:700;letter-spacing:8px;color:${BRAND_PRIMARY}">${code}</span>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 28px 24px">
            <p style="margin:0 0 12px;font-size:13px;line-height:20px;color:${BRAND_TEXT_MUTED}">
              Caduca en pocos minutos y solo puede utilizarse una vez.
            </p>
            <p style="margin:0;font-size:13px;line-height:20px;color:${BRAND_TEXT_MUTED}">
              Si no solicitaste este acceso, ignora este mensaje: nadie puede entrar sin el codigo.
            </p>
          </td>
        </tr>
        <tr>
          <td style="border-top:1px solid ${BRAND_BORDER};padding:16px 28px">
            <p style="margin:0;font-size:11px;line-height:16px;color:${BRAND_TEXT_MUTED}">
              Mensaje automatico de Proto-Do. No respondas a este correo.
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`.trim();
  }
}
