import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';

import type { Transporter } from 'nodemailer';

/** Puerto SMTP por defecto si `SMTP_PORT` no esta definido (envio con STARTTLS). */
const DEFAULT_SMTP_PORT = 587;

/** Puerto SMTP implicito de TLS directo: solo en el 465 se conecta ya cifrado. */
const IMPLICIT_TLS_PORT = 465;

/**
 * Unico punto del backend que conoce SMTP. Los servicios de negocio piden "envia
 * este codigo a este correo" y no saben nada del transporte.
 */
@Injectable()
export class EmailService {
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
    });
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

  /** Plantilla minima del correo; el codigo es el unico dato dinamico. */
  private buildOtpTemplate(code: string): string {
    return [
      '<p>Hola,</p>',
      '<p>Tu codigo de acceso temporal para Proto-Do es:</p>',
      `<p style="font-size:24px;letter-spacing:4px;font-weight:700">${code}</p>`,
      '<p>Caduca en pocos minutos y solo puede utilizarse una vez.</p>',
      '<p>Si no solicitaste este acceso, ignora este mensaje.</p>',
    ].join('');
  }
}
