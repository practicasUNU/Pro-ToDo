import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Tope de destinatarios por aviso.
 *
 * Diez, y no un numero mayor, porque este nodo es una ALERTA a un equipo, no un
 * canal de difusion: el envio masivo es competencia de `DESTINO_ACENS`. Sin
 * tope, un `to` mal construido convertiria cada incidencia de un flujo en un
 * envio que el proveedor acabaria tratando como correo no deseado.
 */
export const MAX_ALERT_RECIPIENTS = 10;

/** Longitud maxima del asunto YA interpolado la impone el propio SMTP. */
export const MAX_ALERT_SUBJECT_LENGTH = 255;

/** Longitud maxima del cuerpo declarado, antes de interpolar. */
export const MAX_ALERT_BODY_LENGTH = 5_000;

/**
 * Configuracion del nodo `DESTINO_SMTP`.
 *
 * TODOS LOS CAMPOS SON OPCIONALES, por el mismo motivo que en el nodo de IA: una
 * PLANTILLA de flujo es una topologia sin operativa y sus `params` van vacios a
 * proposito, asi que un campo obligatorio aqui impediria que ninguna plantilla
 * contuviera este nodo. La pregunta "esta completo para ejecutarse" vive en
 * `getIncompleteParams`, que solo se consulta al ACTIVAR.
 *
 * `subject` y `bodyTemplate` admiten marcadores `{{namespace.campo}}`, que la
 * estrategia resuelve contra el `StatePayloadContext`. El caso que motiva el
 * nodo es citar `{{error_context.error_message}}` y `{{error_context.failed_node_id}}`
 * en el aviso, para que quien lo reciba sepa que flujo se detuvo y por que sin
 * tener que abrir la trazabilidad.
 *
 * NO hay campo de HTML. El cuerpo lo escribe el operador y aceptarlo como
 * marcado lo convertiria en una via de inyeccion en el buzon de quien lo recibe;
 * ademas, el correo institucional con plantilla ya lo produce
 * `MAPEADOR_PLANTILLA`, que si valida su HTML contra la lista de namespaces.
 */
export class SmtpAlertConfigDto {
  @ApiPropertyOptional({
    description:
      'Destinatarios del aviso. Direcciones literales, sin interpolacion.',
    type: [String],
    maxItems: MAX_ALERT_RECIPIENTS,
  })
  // Direcciones LITERALES y no interpolables a proposito: un destinatario que
  // saliera del contenido de un correo entrante dejaria que quien escribe a la
  // bandeja del flujo eligiera a quien avisa el sistema.
  @IsOptional()
  @IsArray({ message: 'to debe ser un arreglo de direcciones.' })
  @ArrayNotEmpty({ message: 'to no puede ser un arreglo vacio.' })
  @ArrayMaxSize(MAX_ALERT_RECIPIENTS, {
    message: `to no puede superar ${MAX_ALERT_RECIPIENTS} destinatarios.`,
  })
  @IsEmail({}, { each: true, message: 'to solo admite direcciones validas.' })
  to?: string[];

  @ApiPropertyOptional({
    description: 'Destinatarios en copia.',
    type: [String],
    maxItems: MAX_ALERT_RECIPIENTS,
  })
  @IsOptional()
  @IsArray({ message: 'cc debe ser un arreglo de direcciones.' })
  @ArrayMaxSize(MAX_ALERT_RECIPIENTS, {
    message: `cc no puede superar ${MAX_ALERT_RECIPIENTS} destinatarios.`,
  })
  @IsEmail({}, { each: true, message: 'cc solo admite direcciones validas.' })
  cc?: string[];

  @ApiPropertyOptional({
    description:
      'Direccion a la que responder, si difiere del remitente configurado.',
  })
  @IsOptional()
  @IsEmail({}, { message: 'replyTo debe ser una direccion valida.' })
  replyTo?: string;

  @ApiPropertyOptional({
    description: 'Asunto del aviso. Admite marcadores {{namespace.campo}}.',
    example: 'Flujo detenido en {{error_context.failed_node_id}}',
    maxLength: MAX_ALERT_SUBJECT_LENGTH,
  })
  @IsOptional()
  @IsString({ message: 'subject debe ser una cadena.' })
  @IsNotEmpty({ message: 'subject no puede estar vacio.' })
  @MaxLength(MAX_ALERT_SUBJECT_LENGTH, {
    message: `subject no puede superar ${MAX_ALERT_SUBJECT_LENGTH} caracteres.`,
  })
  subject?: string;

  @ApiPropertyOptional({
    description:
      'Cuerpo del aviso en texto plano. Admite marcadores {{namespace.campo}}.',
    example:
      'El nodo {{error_context.failed_node_id}} fallo: {{error_context.error_message}}',
    maxLength: MAX_ALERT_BODY_LENGTH,
  })
  @IsOptional()
  @IsString({ message: 'bodyTemplate debe ser una cadena.' })
  @IsNotEmpty({ message: 'bodyTemplate no puede estar vacio.' })
  @MaxLength(MAX_ALERT_BODY_LENGTH, {
    message: `bodyTemplate no puede superar ${MAX_ALERT_BODY_LENGTH} caracteres.`,
  })
  bodyTemplate?: string;
}

/** Configuracion del nodo con los valores por defecto ya aplicados. */
export interface ResolvedSmtpAlertConfig {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly replyTo: string | null;
  readonly subject: string | null;
  readonly bodyTemplate: string | null;
}

/** Aplica los valores por defecto sobre un DTO ya validado. Funcion pura. */
export const resolveSmtpAlertConfig = (
  dto: SmtpAlertConfigDto,
): ResolvedSmtpAlertConfig => ({
  to: dto.to ?? [],
  cc: dto.cc ?? [],
  // `?? null` y no un lanzamiento: el DTO admite la ausencia al guardar, asi que
  // aqui hay que representarla. Quien la convierte en un fallo diagnosticado es
  // la guarda de `execute`, que emite ERR_SMTP_CONFIG antes de abrir conexion.
  replyTo: dto.replyTo ?? null,
  subject: dto.subject ?? null,
  bodyTemplate: dto.bodyTemplate ?? null,
});
