import { ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { ParserEmailConfigDto } from '@modules/nodes/dto/parser-email-config.dto';

/**
 * Tope de caracteres de cada cuerpo de prueba.
 *
 * NO es simetrico con `check-imap`, que no necesita ninguno: alli el cuerpo son
 * siete campos cortos, y aqui es marcado arbitrario que `sanitizeEmailHtml`
 * convierte en un arbol DOM con cheerio, SINCRONO y en el unico hilo del
 * proceso. Un correo de veinte megabytes bloquearia el bucle de eventos del
 * backend entero durante segundos: cualquier EDITOR autenticado tendria una
 * denegacion de servicio de una sola peticion.
 *
 * Cincuenta mil y no mas: `main.ts` NO eleva el limite de `express.json()`, asi
 * que su defecto de 100 kB sigue vigente y un cuerpo mayor devuelve un 413 crudo
 * de Express SIN el mensaje en castellano de este DTO. El tope tiene que quedar
 * por debajo del de Express contando el escapado JSON, que casi dobla el tamano
 * en el peor caso. Un boletin institucional real ronda los 20-60 kB de marcado.
 */
export const MAX_CHECK_PARSER_BODY_CHARS = 50_000;

/** Longitud maxima de linea sin plegar de la RFC 5322 section 2.1.1. */
export const MAX_CHECK_PARSER_SUBJECT_CHARS = 998;

/** Numero maximo de adjuntos simulados. */
export const MAX_CHECK_PARSER_ATTACHMENTS = 20;

/**
 * Adjunto SIMULADO del banco de pruebas: metadatos y jamas el binario.
 *
 * La decision multimodal solo mira `contentType`, nunca los bytes, asi que los
 * metadatos bastan para ejercitar la regla. Excluir `contentBase64` no es una
 * omision sino una barrera: con `forbidNonWhitelisted` enviarlo devuelve un 400,
 * de modo que esta ruta del asistente no puede aceptar megabytes de base64 por
 * mucho que alguien lo intente.
 */
export class CheckParserAttachmentDto {
  @ApiPropertyOptional({ example: 'nota-de-prensa.pdf', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  filename?: string;

  @ApiPropertyOptional({ example: 'application/pdf', maxLength: 127 })
  @IsOptional()
  @IsString()
  @MaxLength(127)
  contentType?: string;

  @ApiPropertyOptional({ example: 1024, minimum: 0 })
  @IsOptional()
  @IsInt({ message: 'size debe ser un numero entero de bytes.' })
  @Min(0, { message: 'size no puede ser negativo.' })
  size?: number;
}

/**
 * Cuerpo de `POST /api/wizard/check-parser`.
 *
 * Hereda `minBodyLength` de `ParserEmailConfigDto` con `PickType` y NO lo
 * redeclara: los decoradores de validacion tienen que ser LOS MISMOS que aplica
 * la estrategia, o el asistente aprobaria un umbral que la ejecucion rechaza,
 * que es justo lo contrario de lo que aporta este paso.
 *
 * `PickType` viene de `@nestjs/swagger` y no de `@nestjs/mapped-types` —tambien
 * instalado y usado en otros DTOs—: solo aquella version arrastra los
 * `@ApiPropertyOptional`, y con la otra el campo desapareceria del documento sin
 * que nada fallase.
 *
 * `sourceNamespace` se deja FUERA del `PickType` a proposito: aqui no hay
 * contexto del que leer, porque el correo viaja en el propio cuerpo, asi que
 * aceptarlo seria admitir un campo que no hace nada. Con `forbidNonWhitelisted`
 * enviarlo devuelve un 400 honesto en vez de ignorarse en silencio.
 */
export class CheckParserDto extends PickType(ParserEmailConfigDto, [
  'minBodyLength',
] as const) {
  @ApiPropertyOptional({
    description: 'Asunto del correo de prueba',
    example: 'RV: Re: Nota de prensa institucional',
    maxLength: MAX_CHECK_PARSER_SUBJECT_CHARS,
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CHECK_PARSER_SUBJECT_CHARS, {
    message: `El asunto no puede superar ${MAX_CHECK_PARSER_SUBJECT_CHARS} caracteres.`,
  })
  subject?: string;

  @ApiPropertyOptional({
    description:
      'Cuerpo en texto plano. Si viene relleno, el nodo lo prefiere sobre el marcado',
    maxLength: MAX_CHECK_PARSER_BODY_CHARS,
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CHECK_PARSER_BODY_CHARS, {
    message: `El texto de prueba no puede superar ${MAX_CHECK_PARSER_BODY_CHARS} caracteres.`,
  })
  text?: string;

  @ApiPropertyOptional({
    description:
      'Cuerpo en HTML. Es el plan B del multipart/alternative sin parte de texto',
    maxLength: MAX_CHECK_PARSER_BODY_CHARS,
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CHECK_PARSER_BODY_CHARS, {
    message: `El HTML de prueba no puede superar ${MAX_CHECK_PARSER_BODY_CHARS} caracteres.`,
  })
  html?: string;

  @ApiPropertyOptional({
    description:
      'Adjuntos simulados, sin binario. Necesarios para ejercitar la regla multimodal',
    type: [CheckParserAttachmentDto],
    maxItems: MAX_CHECK_PARSER_ATTACHMENTS,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CHECK_PARSER_ATTACHMENTS, {
    message: `No se admiten mas de ${MAX_CHECK_PARSER_ATTACHMENTS} adjuntos simulados.`,
  })
  @ValidateNested({ each: true })
  @Type(() => CheckParserAttachmentDto)
  attachments?: CheckParserAttachmentDto[];
}
