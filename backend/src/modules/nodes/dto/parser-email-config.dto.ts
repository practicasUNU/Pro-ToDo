import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsPositive } from 'class-validator';

import { NODE_OUTPUT_NAMESPACES } from '@core/fsm/types/pipeline-schema.types';

/** Namespace del que el parser lee el correo crudo. */
export const DEFAULT_PARSER_SOURCE_NAMESPACE = 'raw_email';

/**
 * Longitud minima, en caracteres, para dar por bueno un cuerpo textual.
 *
 * Por debajo de este umbral se considera que el correo no trae texto que un
 * modelo de lenguaje pueda aprovechar. 200 caracteres son unas tres frases: un
 * pie de firma o un "ver adjunto" se quedan claramente por debajo, y cualquier
 * aviso real lo supera con holgura.
 */
export const DEFAULT_MIN_BODY_LENGTH = 200;

/**
 * Configuracion del nodo `PARSER_PRE_IA`.
 *
 * Minima a proposito: esta version todavia no sanea el marcado —eso llega con
 * `cheerio` / `@mozilla/readability`— y solo necesita saber de donde lee y con
 * que umbral decide. Aun asi tiene DTO propio, y no es ceremonia: el esquema
 * valida `params` como objeto libre, asi que la unica estrictez real es la que
 * aplica la estrategia. Sin el, un `minBodyLenght` mal escrito se ignoraria en
 * silencio y el criterio multimodal quedaria decidido por un defecto que nadie
 * pidio.
 */
export class ParserEmailConfigDto {
  @ApiPropertyOptional({
    description: `Namespace del que se lee el correo crudo. Por defecto "${DEFAULT_PARSER_SOURCE_NAMESPACE}"`,
    enum: NODE_OUTPUT_NAMESPACES,
    default: DEFAULT_PARSER_SOURCE_NAMESPACE,
  })
  @IsOptional()
  // Lista cerrada y no un patron libre: leer de un namespace que ningun nodo
  // puede escribir nunca es un error de diseno del flujo, y detectarlo al
  // validar es mas barato que descubrirlo con el flujo PAUSADO.
  @IsIn(NODE_OUTPUT_NAMESPACES, {
    message: `sourceNamespace debe ser uno de: ${NODE_OUTPUT_NAMESPACES.join(', ')}.`,
  })
  sourceNamespace?: string;

  @ApiPropertyOptional({
    description: `Umbral de caracteres por debajo del cual el cuerpo se considera insuficiente. Por defecto ${DEFAULT_MIN_BODY_LENGTH}`,
    example: DEFAULT_MIN_BODY_LENGTH,
    default: DEFAULT_MIN_BODY_LENGTH,
  })
  @IsOptional()
  @IsInt({ message: 'minBodyLength debe ser un numero entero.' })
  @IsPositive({ message: 'minBodyLength debe ser mayor que cero.' })
  minBodyLength?: number;
}

/** Configuracion del parser con los valores por defecto ya aplicados. */
export interface ResolvedParserEmailConfig {
  readonly sourceNamespace: string;
  readonly minBodyLength: number;
}

/** Aplica los valores por defecto sobre un DTO ya validado. Funcion pura. */
export const resolveParserEmailConfig = (
  dto: ParserEmailConfigDto | ResolvedParserEmailConfig,
): ResolvedParserEmailConfig => ({
  sourceNamespace: dto.sourceNamespace ?? DEFAULT_PARSER_SOURCE_NAMESPACE,
  minBodyLength: dto.minBodyLength ?? DEFAULT_MIN_BODY_LENGTH,
});
