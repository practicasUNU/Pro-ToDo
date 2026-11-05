import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { NodeErrorSeverity } from '@core/fsm/types/node-strategy.types';

/**
 * Proyeccion de lo que el nodo depositaria en el namespace `scraped_web`.
 *
 * Las cinco claves van en `snake_case` porque asi viajan: son las que una
 * plantilla interpola como `{{scraped_web.full_article_content}}`, y camelizarlas
 * en la respuesta haria que el banco de pruebas mostrase nombres que ninguna
 * plantilla puede escribir. Mismo criterio que `ParsedEmailPreviewDto`.
 */
export class ScrapedWebPreviewDto {
  @ApiProperty({
    description: 'URL FINAL, ya resuelta la cadena de redirecciones',
    example: 'https://www.ejemplo.es/noticias/nota-de-prensa',
  })
  source_url: string;

  @ApiProperty({ description: 'Titulo crudo que aislo Readability' })
  article_title: string;

  @ApiProperty({
    description:
      'Texto plano del articulo, sin una sola etiqueta y con los saltos de parrafo conservados',
  })
  full_article_content: string;

  @ApiProperty({
    description:
      'Firma del articulo. `null` es "sin firma", distinto de una cadena vacia',
    nullable: true,
    example: 'Redaccion Local',
  })
  byline: string | null;

  @ApiProperty({
    description: 'Autor de los metadatos (meta/JSON-LD), o la firma si no hay',
    nullable: true,
  })
  author: string | null;

  @ApiProperty({
    description: 'Fecha de publicacion ISO 8601, o null si no consta',
    nullable: true,
  })
  published_at: string | null;

  @ApiProperty({
    description: 'URLs externas citadas en el cuerpo del articulo',
    type: [String],
  })
  references: string[];

  @ApiProperty({ description: 'Marca temporal ISO 8601 de la extraccion' })
  scraped_at: string;
}

/**
 * Metricas del intento. Presentes tambien cuando `success` es false.
 *
 * Existen porque el operador tiene que calibrar `timeoutMs` y `maxRetries`, y
 * sin el tiempo real medido esos dos campos se rellenan a ojo. Es la
 * contrapartida del `reduction_percentage` del parser: la metrica que convierte
 * el formulario en algo accionable en vez de una lista de numeros por defecto.
 */
export class CheckScraperMetricsDto {
  @ApiProperty({ description: 'Tiempo total de la prueba, en milisegundos' })
  elapsedMs: number;

  @ApiProperty({
    description: 'Navegaciones consumidas, incluida la que cerro el intento',
  })
  attempts: number;

  @ApiProperty({
    description: 'true si el portal redirigio a una URL distinta de la pedida',
  })
  redirected: boolean;

  @ApiProperty({
    description: 'Caracteres del texto extraido. Cero si no hubo extraccion',
  })
  contentLength: number;
}

/**
 * Detalle del fallo.
 *
 * A diferencia de `CheckParserErrorDto`, este SI expone el `code`: los codigos
 * `ERR_SCRAPER_*` son el vocabulario del diagnostico de este nodo, y distinguir
 * `ERR_ACCESS_DENIED_BLOCK_DETECTED` de `ERR_SCRAPER_EMPTY_CONTENT` es
 * literalmente la diferencia entre "cambia de fuente" y "sube el timeout".
 *
 * `stackTrace` NO viaja, igual que en los otros dos endpoints del asistente:
 * revela rutas del sistema de archivos del servidor y no aporta nada a quien
 * esta rellenando un formulario.
 */
export class CheckScraperErrorDto {
  @ApiProperty({
    description:
      'Severidad, con la misma escala que `NodeResult.error.level`. Siempre GRAVE en este nodo',
    example: 'GRAVE',
    enum: ['LEVE', 'GRAVE', 'URGENTE'],
  })
  level: NodeErrorSeverity;

  @ApiProperty({
    description:
      'Codigo estable del fallo, el mismo que un `catchErrors` puede enrutar',
    example: 'ERR_ACCESS_DENIED_BLOCK_DETECTED',
  })
  code: string;

  @ApiProperty({ description: 'Motivo legible del fallo' })
  message: string;
}

/**
 * Resultado del banco de pruebas del extractor web.
 *
 * Un portal caido o un muro de pago NO son `success: false` de la PETICION: son
 * un 200 con `success: false` en el cuerpo, porque el diagnostico del portal ES
 * la respuesta que el asistente tiene que mostrar. El 4xx queda para un cuerpo
 * mal formado. Mismo criterio que `checkImap` y `checkParser`.
 */
export class CheckScraperResponseDto {
  @ApiProperty({
    description:
      'false ante cualquier fallo de navegacion, bloqueo o pagina sin articulo',
    example: true,
  })
  success: boolean;

  @ApiPropertyOptional({
    description: 'Payload que el nodo depositaria en `scraped_web`',
    type: ScrapedWebPreviewDto,
  })
  preview?: ScrapedWebPreviewDto;

  @ApiPropertyOptional({
    description: 'Metricas del intento, presentes tambien cuando fracasa',
    type: CheckScraperMetricsDto,
  })
  metrics?: CheckScraperMetricsDto;

  @ApiPropertyOptional({
    description:
      'Avisos que en la ejecucion real solo llegan al archivo `.log` del servidor',
    type: [String],
  })
  warnings?: string[];

  @ApiPropertyOptional({
    description: 'Detalle del fallo. Presente solo cuando `success` es false',
    type: CheckScraperErrorDto,
  })
  error?: CheckScraperErrorDto;
}
