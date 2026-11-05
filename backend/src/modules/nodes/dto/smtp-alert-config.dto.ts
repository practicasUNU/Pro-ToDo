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

/**
 * Longitud maxima de la nota del operador.
 *
 * Dos mil y no los cinco mil del antiguo `bodyTemplate`: aquello era el cuerpo
 * ENTERO del aviso y tenia que caber todo; esto es una acotacion que acompana a
 * una carta que el sistema ya compone. Una nota mas larga que la propia carta
 * deja de ser una nota.
 */
export const MAX_ALERT_NOTE_LENGTH = 2_000;

/**
 * Configuracion del nodo `DESTINO_SMTP`.
 *
 * TODOS LOS CAMPOS SON OPCIONALES, por el mismo motivo que en el nodo de IA: una
 * PLANTILLA de flujo es una topologia sin operativa y sus `params` van vacios a
 * proposito, asi que un campo obligatorio aqui impediria que ninguna plantilla
 * contuviera este nodo. La pregunta "esta completo para ejecutarse" vive en
 * `getIncompleteParams`, que solo se consulta al ACTIVAR.
 *
 * NO HAY CUERPO. Lo hubo —`bodyTemplate`, obligatorio— y se retiro: el cuerpo lo
 * compone ahora `buildAlertEmailHtml` como carta institucional, de modo que el
 * operador configura A QUIEN avisar, CON QUE asunto y QUE nota anadir, y no
 * escribe ni una etiqueta. Redactar el aviso entero a mano en un `textarea` era
 * pedirle que reprodujese en cada nodo lo que el sistema ya sabe decir, y el
 * resultado eran avisos que omitian justo el dato que hacia falta.
 *
 * `subject` admite marcadores `{{namespace.campo}}` que la estrategia resuelve
 * contra el `StatePayloadContext`, y tiene defecto propio: ver
 * `DEFAULT_ALERT_SUBJECT`. `customMessage` NO se interpola —es una nota en texto
 * plano— para no anadirle un modo de fallo a un campo cuyo proposito es que
 * siempre se lea.
 *
 * Sigue sin haber campo de HTML, y por el mismo motivo de siempre: el marcado
 * que aporta el operador es una via de inyeccion en el buzon de quien recibe la
 * alerta. La nota se escapa caracter a caracter antes de incrustarse.
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
      'Nota del operador en TEXTO PLANO, incrustada en la carta de alerta. No se interpola: un {{...}} escrito aqui sale literal.',
    example:
      'Avisar tambien al responsable de guardia si se repite tres veces.',
    maxLength: MAX_ALERT_NOTE_LENGTH,
  })
  @IsOptional()
  @IsString({ message: 'customMessage debe ser una cadena.' })
  @MaxLength(MAX_ALERT_NOTE_LENGTH, {
    message: `customMessage no puede superar ${MAX_ALERT_NOTE_LENGTH} caracteres.`,
  })
  // Sin `@IsNotEmpty`, a diferencia de `subject`: una nota vacia es una nota que
  // el operador borro, y la carta simplemente no pinta ese bloque. Rechazarla
  // obligaria al cliente a distinguir entre no enviar la clave y enviarla vacia,
  // que es justo la clase de detalle que acaba en un 400 incomprensible.
  customMessage?: string;
}

/** Configuracion del nodo con los valores por defecto ya aplicados. */
export interface ResolvedSmtpAlertConfig {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly replyTo: string | null;
  readonly subject: string | null;
  readonly customMessage: string | null;
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
  customMessage: dto.customMessage ?? null,
});
