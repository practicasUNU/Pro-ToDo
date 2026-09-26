import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
} from 'class-validator';

import { NODE_OUTPUT_NAMESPACES } from '@core/fsm/types/pipeline-schema.types';

/** Namespace del que el parser lee el correo crudo. */
export const DEFAULT_PARSER_SOURCE_NAMESPACE = 'raw_email';

/**
 * Longitud minima, en caracteres, para dar por bueno un cuerpo textual.
 *
 * Por debajo de este umbral se considera que el correo no trae texto que un
 * modelo de lenguaje pueda aprovechar.
 *
 * RECALIBRADO DE 200 A 50 al entrar el saneador. Los 200 originales estaban
 * medidos contra texto SIN sanear, donde una firma y un pie legal sumaban solos
 * unos 300 caracteres y casi cualquier correo superaba el listado por puro
 * ruido. Ahora `clean_body` es texto util: 50 caracteres son una frase con
 * sujeto y predicado, y un "Adjunto la nota de prensa" (25) se queda debajo,
 * que es exactamente donde tiene que quedarse.
 *
 * Va en sincronia con `FSM_MIN_USEFUL_TEXT_LENGTH` del motor, que decide con el
 * mismo listado si libera el binario de los adjuntos. Moverlo aqui sin mover
 * aquel reabre la ventana en la que el correo declara texto suficiente para
 * purgar y a la vez insuficiente para el modelo.
 */
export const DEFAULT_MIN_BODY_LENGTH = 50;

/**
 * Configuracion del nodo `PARSER_PRE_IA`.
 *
 * Minima a proposito, y sigue siendolo despues del saneador: el nodo solo
 * necesita saber DE DONDE lee y CON QUE umbral decide. Las heuristicas de
 * limpieza no se exponen como opciones —no hay `stripSignatures` ni
 * `filterSocialUrls`— porque cada interruptor multiplica las formas posibles del
 * payload historico: un `extracted_urls: []` significaria a veces "no habia
 * enlaces" y a veces "alguien apago la extraccion ese dia", y ningun checkpoint
 * de hace seis meses puede distinguirlas. Ademas, un flujo que quiera la firma
 * quiere el correo crudo, y ese sigue intacto en `raw_email`.
 *
 * Aun asi tiene DTO propio, y no es ceremonia: el esquema valida `params` como
 * objeto libre, asi que la unica estrictez real es la que aplica la estrategia.
 * Sin el, un `minBodyLenght` mal escrito se ignoraria en silencio y el criterio
 * multimodal quedaria decidido por un defecto que nadie pidio.
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
    description: `Umbral de caracteres del cuerpo YA SANEADO por debajo del cual se considera insuficiente para un modelo de lenguaje. Por defecto ${DEFAULT_MIN_BODY_LENGTH}`,
    example: DEFAULT_MIN_BODY_LENGTH,
    default: DEFAULT_MIN_BODY_LENGTH,
  })
  @IsOptional()
  @IsInt({ message: 'minBodyLength debe ser un numero entero.' })
  @IsPositive({ message: 'minBodyLength debe ser mayor que cero.' })
  minBodyLength?: number;

  @ApiPropertyOptional({
    description:
      'Convierte el correo sin texto aprovechable (solo imagen o PDF escaneado) en un fallo ERR_PARSER_UNEXTRACTABLE_MEDIA, para poder desviarlo con `onErrorStep`. Por defecto false: el caso se senala con la bandera `requires_multimodal_fallback` y el flujo continua.',
    default: false,
  })
  // El defecto es `false`, y no es timidez: sin el, activar esta entrega
  // convertiria en PAUSADO todos los flujos ya guardados que hoy atraviesan
  // tranquilamente un correo de solo imagen, sin que nadie hubiera pedido ese
  // cambio. Bifurcar es una decision del disenador del flujo, no del despliegue.
  @IsOptional()
  @IsBoolean({ message: 'failOnUnextractableMedia debe ser un booleano.' })
  failOnUnextractableMedia?: boolean;
}

/** Configuracion del parser con los valores por defecto ya aplicados. */
export interface ResolvedParserEmailConfig {
  readonly sourceNamespace: string;
  readonly minBodyLength: number;
  readonly failOnUnextractableMedia: boolean;
}

/** Aplica los valores por defecto sobre un DTO ya validado. Funcion pura. */
export const resolveParserEmailConfig = (
  dto: ParserEmailConfigDto | ResolvedParserEmailConfig,
): ResolvedParserEmailConfig => ({
  sourceNamespace: dto.sourceNamespace ?? DEFAULT_PARSER_SOURCE_NAMESPACE,
  minBodyLength: dto.minBodyLength ?? DEFAULT_MIN_BODY_LENGTH,
  failOnUnextractableMedia: dto.failOnUnextractableMedia ?? false,
});
