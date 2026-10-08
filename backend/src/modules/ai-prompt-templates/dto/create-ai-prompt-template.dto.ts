import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/** Replica `plantillas_prompts_ia.codigo VARCHAR(50)`. */
export const MAX_CODE_LENGTH = 50;

/**
 * Forma admitida de un codigo: mayusculas, digitos y guion bajo.
 *
 * Se cierra la forma a proposito. El codigo acaba escrito a mano dentro de los
 * `params` de un nodo, y un `licitacion default` con espacios o acentos seria
 * imposible de teclear igual dos veces.
 */
export const CODE_PATTERN = /^[A-Z0-9_]+$/;

/** Replica `plantillas_prompts_ia.nombre VARCHAR(120)`. */
const MAX_NAME_LENGTH = 120;

/** Replica `plantillas_prompts_ia.descripcion VARCHAR(255)`. */
const MAX_DESCRIPTION_LENGTH = 255;

/**
 * Alta de prompt de IA (PROT-15.2).
 *
 * No incluye `createdById`: la autoria sale del JWT. Aceptarla por el cuerpo
 * permitiria suplantarla.
 *
 * Tampoco incluye proveedor, modelo ni temperatura, y no es un olvido: el
 * desacoplamiento del modulo empieza aqui. Un prompt es texto reutilizable; el
 * modelo que lo ejecuta lo elige el nodo.
 */
export class CreateAiPromptTemplateDto {
  /**
   * OPCIONAL: omitirlo hace que el servicio lo DERIVE del nombre.
   *
   * Nacio obligatorio y eso dejaba el alta rota desde la interfaz: el
   * formulario de Quasar no tenia el campo, asi que toda creacion desde el
   * navegador se iba en un 400 que no explicaba nada. Exigir aqui un slug que
   * la mayoria de operadores no sabe que existe es pedirle al usuario que
   * resuelva un detalle de implementacion.
   *
   * Suministrarlo sigue siendo lo preferible cuando el prompt va a citarse
   * desde un `pipeline_schema` versionado, porque entonces el literal lo elige
   * una persona y no un algoritmo. Y si choca con uno existente, el servicio
   * devuelve 409 en vez de renombrarlo: ahi hubo una intencion concreta.
   *
   * OJO CON LA CADENA VACIA. `@IsOptional` solo salta el resto de validadores
   * con `undefined` o `null`; un `''` llegaria a `@Matches` y daria 400. El
   * servicio la trata como ausencia y el formulario no la envia, pero conviene
   * no enviarla.
   */
  @ApiPropertyOptional({
    description:
      'Clave de maquina del prompt, inmutable. Es lo que cita `promptCode` en los ' +
      'params del nodo PROCESADOR_IA, y la unica referencia que sobrevive a un ' +
      'clonado de la base o a un renombrado de la etiqueta visible. Si se omite, ' +
      'se deriva del nombre.',
    example: 'LICITACION_APERTURA_DEFAULT',
    maxLength: MAX_CODE_LENGTH,
    pattern: CODE_PATTERN.source,
  })
  @IsOptional()
  @IsString({ message: 'code debe ser una cadena.' })
  @MaxLength(MAX_CODE_LENGTH, {
    message: `code no puede superar ${MAX_CODE_LENGTH} caracteres.`,
  })
  @Matches(CODE_PATTERN, {
    message: 'code solo admite mayusculas, digitos y guion bajo.',
  })
  readonly code?: string;

  @ApiProperty({
    description: 'Nombre unico del prompt, visible en el selector del nodo IA',
    example: 'extraccion-noticia-es',
    maxLength: MAX_NAME_LENGTH,
  })
  @IsString({ message: 'name debe ser una cadena.' })
  @IsNotEmpty({ message: 'name no puede estar vacio.' })
  @MaxLength(MAX_NAME_LENGTH, {
    message: `name no puede superar ${MAX_NAME_LENGTH} caracteres.`,
  })
  readonly name: string;

  @ApiPropertyOptional({
    description: 'Proposito del prompt, para el listado administrativo',
    example: 'Extrae titular y resumen de un correo en espanol',
    maxLength: MAX_DESCRIPTION_LENGTH,
  })
  @IsOptional()
  @IsString({ message: 'description debe ser una cadena.' })
  @MaxLength(MAX_DESCRIPTION_LENGTH, {
    message: `description no puede superar ${MAX_DESCRIPTION_LENGTH} caracteres.`,
  })
  readonly description?: string;

  @ApiProperty({
    description:
      'Instruccion semantica. Admite marcadores {{nodo.campo}}, que resuelve el ' +
      'motor contra los namespaces del contexto en tiempo de ejecucion.',
    example:
      'Extrae el titular y un resumen de dos frases del siguiente texto: {{parsed_email.clean_body}}',
  })
  @IsString({ message: 'promptText debe ser una cadena.' })
  @IsNotEmpty({ message: 'promptText no puede estar vacio.' })
  readonly promptText: string;

  @ApiPropertyOptional({
    description:
      'Disponibilidad del prompt. En el alta se ignora (todo prompt nace activo); ' +
      'en la edicion es la via para reactivar uno retirado desde la tabla administrativa.',
    example: true,
    default: true,
  })
  @IsOptional()
  @IsBoolean({ message: 'active debe ser un booleano.' })
  readonly active?: boolean;
}
