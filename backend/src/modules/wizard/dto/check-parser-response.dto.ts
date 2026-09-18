import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { NodeErrorSeverity } from '@core/fsm/types/node-strategy.types';
import type { RawEmailAttachmentMetadata } from '@modules/nodes/interfaces/raw-email-attachment.interface';
import type {
  BodySource,
  ParsedEmailPayload,
} from '@modules/nodes/utils/parsed-email-payload.util';

/** Inventario de un adjunto tal como lo publica el nodo: sin su binario. */
export class ParsedEmailAttachmentDto implements RawEmailAttachmentMetadata {
  @ApiProperty({ example: 'nota-de-prensa.pdf' })
  filename: string;

  @ApiProperty({ example: 'application/pdf' })
  contentType: string;

  @ApiProperty({ description: 'Bytes decodificados', example: 1024 })
  size: number;
}

/**
 * Proyeccion documentada de `ParsedEmailPayload`, las doce claves EN ORDEN.
 *
 * Existe porque una `interface` de TypeScript no genera esquema de Swagger. El
 * `implements` no es decorativo: ata esta clase al contrato real del nodo, de
 * modo que anadir o quitar una clave alli rompe la compilacion aqui en vez de
 * dejar el documento describiendo una respuesta que ya no existe.
 *
 * Las claves van en `snake_case` porque asi viajan: son las que una plantilla
 * interpola como `{{parsed_email.clean_body}}`, y camelizarlas en la respuesta
 * haria que el banco de pruebas mostrase nombres que ninguna plantilla puede
 * escribir.
 */
export class ParsedEmailPreviewDto implements ParsedEmailPayload {
  @ApiProperty({ description: 'Asunto crudo, tal cual llego' })
  subject: string;

  @ApiProperty({ description: 'Asunto sin prefijos de respuesta ni reenvio' })
  clean_title: string;

  @ApiProperty({
    description:
      'Cuerpo saneado. SIEMPRE una cadena; vacia significa que no habia texto',
  })
  clean_body: string;

  @ApiProperty({
    description: 'Fuente de la que salio el cuerpo',
    enum: ['text', 'html', 'none'],
  })
  body_source: BodySource;

  @ApiProperty({ description: 'Longitud de `clean_body`' })
  character_count: number;

  @ApiProperty({
    description:
      'Longitud de la fuente CONSUMIDA (texto o marcado), no del correo entero',
  })
  original_character_count: number;

  @ApiProperty({
    description: 'Porcentaje de reduccion, de 0 a 100',
    example: 87.22,
  })
  reduction_percentage: number;

  @ApiProperty({
    description:
      'Enlaces de contenido, sin parametros de campana y deduplicados',
    type: [String],
  })
  extracted_urls: readonly string[];

  @ApiProperty()
  attachment_count: number;

  @ApiProperty({ type: [ParsedEmailAttachmentDto] })
  attachments: readonly ParsedEmailAttachmentDto[];

  @ApiProperty({
    description:
      'Exige AMBAS condiciones: adjunto de imagen o PDF Y cuerpo por debajo del umbral',
  })
  requires_multimodal_fallback: boolean;

  @ApiProperty({
    description: 'Motivo legible. Cadena vacia cuando la bandera es false',
  })
  multimodal_reason: string;
}

/** Detalle de un fallo inesperado, con la severidad del motor FSM. */
export class CheckParserErrorDto {
  @ApiProperty({
    description:
      'Severidad del fallo, con la misma escala que `NodeResult.error.level`',
    example: 'GRAVE',
    enum: ['LEVE', 'GRAVE', 'URGENTE'],
  })
  level: NodeErrorSeverity;

  @ApiProperty({ description: 'Motivo legible del fallo' })
  message: string;
}

/**
 * Resultado del banco de pruebas del parser.
 *
 * NO incluye `stackTrace`, igual que `CheckImapResponseDto`: la traza revela
 * rutas del sistema de archivos del servidor y no aporta nada a quien esta
 * rellenando un formulario.
 *
 * Un correo sin texto aprovechable NO es `success: false`. La estrategia degrada
 * ese caso a `body_source: 'none'`, y el asistente tiene que reproducir esa
 * decision EXACTAMENTE o estaria mintiendo sobre lo que ocurrira en produccion.
 * El `success: false` queda reservado a una excepcion inesperada de la
 * composicion.
 */
export class CheckParserResponseDto {
  @ApiProperty({
    description: 'false solo ante un fallo inesperado de la composicion',
    example: true,
  })
  success: boolean;

  @ApiPropertyOptional({
    description: 'Payload que el nodo depositaria en `parsed_email`',
    type: ParsedEmailPreviewDto,
  })
  parsed?: ParsedEmailPreviewDto;

  @ApiPropertyOptional({
    description:
      'Avisos que en la ejecucion real solo llegan al archivo `.log` del servidor',
    type: [String],
  })
  warnings?: string[];

  @ApiPropertyOptional({
    description: 'Detalle del fallo. Presente solo cuando `success` es false',
    type: CheckParserErrorDto,
  })
  error?: CheckParserErrorDto;
}
