import { ApiProperty, PickType } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUrl, MaxLength } from 'class-validator';

import { WebScraperConfigDto } from '@modules/nodes/dto/web-scraper-config.dto';

/**
 * Tope de longitud de la URL de prueba.
 *
 * 2048 es el limite practico que imponen los navegadores; una cadena mas larga
 * no la podria abrir ni Chromium, asi que rechazarla aqui evita pagar el
 * arranque del navegador para nada.
 */
export const MAX_CHECK_SCRAPER_URL_CHARS = 2_048;

/**
 * Cuerpo de `POST /api/wizard/check-scraper`.
 *
 * Hereda `timeoutMs`, `maxRetries` y `retryDelayMs` del DTO del nodo con
 * `PickType` de `@nestjs/swagger` —no el de `@nestjs/mapped-types`, que perderia
 * los `@ApiPropertyOptional`—, para que los topes que aprueba el asistente sean
 * EXACTAMENTE los que aplica la estrategia. Si divergieran, una configuracion
 * podria pasar la comprobacion y fallar en la ejecucion, que es justo lo
 * contrario de lo que aporta el paso.
 *
 * `targetUrl` es la UNICA divergencia deliberada, y va al reves de lo habitual:
 * aqui se valida MAS. En el nodo el valor es casi siempre
 * `{{parsed_email.extracted_urls[0]}}`, que no es una URL hasta que el contexto
 * la resuelve, y por eso alli no lleva `@IsUrl()`. En el banco de pruebas no hay
 * contexto ninguno: el operador prueba contra una URL REAL, y una plantilla sin
 * resolver solo podria acabar en un `new URL()` que lanza. Se rechaza en el DTO
 * para que el 400 nombre el campo en vez de aparecer como un fallo del servidor.
 */
export class CheckScraperDto extends PickType(WebScraperConfigDto, [
  'timeoutMs',
  'maxRetries',
  'retryDelayMs',
] as const) {
  @ApiProperty({
    description:
      'URL REAL y absoluta del articulo a probar. NO admite plantillas `{{...}}`: este endpoint no tiene contexto contra el que interpolar',
    example: 'https://www.ejemplo.es/noticias/nota-de-prensa',
    maxLength: MAX_CHECK_SCRAPER_URL_CHARS,
  })
  @IsString({ message: 'targetUrl debe ser una cadena.' })
  @IsNotEmpty({ message: 'targetUrl no puede estar vacio.' })
  @MaxLength(MAX_CHECK_SCRAPER_URL_CHARS, {
    message: `targetUrl no puede superar ${MAX_CHECK_SCRAPER_URL_CHARS} caracteres.`,
  })
  // Lista BLANCA de esquemas, con el mismo criterio que `resolveTargetUrl` de la
  // estrategia: sin `protocols` este validador dejaria pasar formas que no son
  // navegables, y abrir un `file:` desde aqui seria una lectura arbitraria del
  // disco del servidor disparada por un EDITOR autenticado.
  //
  // `require_tld: false` a proposito: permite probar contra un host interno de
  // la intranet (`http://intranet/nota`), que es un caso real en una
  // implantacion corporativa.
  @IsUrl(
    {
      protocols: ['http', 'https'],
      require_protocol: true,
      require_tld: false,
    },
    {
      message:
        'targetUrl debe ser una URL http o https absoluta. Las plantillas {{...}} no se admiten en el banco de pruebas: aqui no hay contexto que interpolar.',
    },
  )
  targetUrl!: string;
}
