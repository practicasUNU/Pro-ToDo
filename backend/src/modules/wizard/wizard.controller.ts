import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { ImapTriggerConfigDto } from '@modules/nodes/dto/imap-trigger-config.dto';
import { UserRole } from '@modules/users/enums/user-role.enum';

import { CheckImapResponseDto } from './dto/check-imap-response.dto';
import { CheckParserResponseDto } from './dto/check-parser-response.dto';
import { CheckParserDto } from './dto/check-parser.dto';
import { CheckScraperResponseDto } from './dto/check-scraper-response.dto';
import { CheckScraperDto } from './dto/check-scraper.dto';
import { WizardService } from './wizard.service';

/**
 * `ValidationPipe` propio, con `forbidNonWhitelisted`.
 *
 * El pipe global de `main.ts` solo lleva `{ whitelist: true, transform: true }`,
 * que ELIMINA en silencio las propiedades desconocidas. Aqui hace falta que las
 * RECHACE: un cliente que envie `password` en el cuerpo debe recibir un 400, no
 * un 200 tras haberse descartado el campo sin decir nada. Es la misma opcion que
 * aplica `ImapTriggerStrategy` al validar los `params` del nodo, de modo que la
 * comprobacion del asistente y la ejecucion real usen el mismo criterio.
 */
const STRICT_VALIDATION = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

/**
 * Superficie HTTP del asistente de creacion de flujos.
 *
 * Doble barrera, igual que `WorkflowsController`: la ruta no lleva `@PublicIp()`,
 * de modo que el `IpWhitelistGuard` global (PROT-05) la cubre, y ademas exige
 * JWT y rol. Abierta a ADMIN y EDITOR porque configurar flujos es competencia
 * del EDITOR (`security-and-scope.md` §2).
 *
 * Los guards y los roles se declaran a nivel de CLASE para que ningun endpoint
 * que se anada despues quede desprotegido por olvido (Poka-Yoke).
 *
 * Que este endpoint acepte un host y un usuario arbitrarios lo convierte en un
 * oraculo de conectividad, y de ahi que las tres barreras importen: sin el
 * patron `IMAP_*PASSWORD` de `passwordEnvKey`, cualquiera con rol EDITOR podria
 * pedir al backend que enviase `JWT_SECRET` a un servidor propio y confirmar el
 * acierto leyendo el `success` de la respuesta.
 */
@ApiTags('wizard')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, expirado o invalido' })
@ApiForbiddenResponse({
  description: 'IP fuera de la red corporativa o rol distinto de ADMIN/EDITOR',
})
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.EDITOR)
@Controller('wizard')
export class WizardController {
  constructor(private readonly wizardService: WizardService) {}

  /**
   * Comprueba las credenciales IMAP antes de guardar el nodo.
   *
   * `HttpStatus.OK` y no el 201 por defecto de `@Post`: no se crea ningun
   * recurso, se devuelve el resultado de una comprobacion.
   *
   * Un fallo de conexion es un 200 con `success: false`, no un 4xx: el
   * diagnostico del servidor de correo forma parte de la respuesta que el
   * asistente tiene que mostrar. El 400 queda reservado a un cuerpo mal formado.
   */
  @Post('check-imap')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Valida la conectividad IMAP de un nodo TRIGGER_IMAP resolviendo la credencial desde el entorno',
  })
  @ApiOkResponse({
    description:
      'Comprobacion realizada. `success` indica si se pudo autenticar y abrir el buzon',
    type: CheckImapResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'Cuerpo invalido: falta un campo obligatorio, `passwordEnvKey` no cumple el patron IMAP_*PASSWORD, o se envio una propiedad no permitida como `password`',
  })
  public async checkImap(
    @Body(STRICT_VALIDATION) imapTriggerConfigDto: ImapTriggerConfigDto,
  ): Promise<CheckImapResponseDto> {
    return this.wizardService.checkImap(imapTriggerConfigDto);
  }

  /**
   * Sanea un correo de prueba con la misma logica del nodo PARSER_PRE_IA.
   *
   * `HttpStatus.OK` por el mismo motivo que el anterior: no se crea ningun
   * recurso, se devuelve el resultado de una comprobacion. Y tampoco persiste
   * nada: el correo de prueba vive solo el tiempo de la peticion.
   *
   * Hereda los guards y los roles declarados a nivel de CLASE, que es
   * exactamente el motivo por el que estan ahi: un endpoint anadido despues no
   * puede quedar desprotegido por olvido.
   *
   * A diferencia de `check-imap` este endpoint NO es un oraculo de red —la
   * composicion es pura y no abre un solo socket—, pero si es un consumidor de
   * CPU: de ahi los topes de longitud del DTO, que son su unica barrera real.
   */
  @Post('check-parser')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Sanea un correo de prueba con la misma logica del nodo PARSER_PRE_IA y devuelve el payload de parsed_email',
  })
  @ApiOkResponse({
    description:
      'Correo procesado. `parsed` trae las trece claves deterministas del nodo',
    type: CheckParserResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'Cuerpo invalido: `minBodyLength` no positivo, un cuerpo por encima del tope de caracteres, o una propiedad no permitida como `sourceNamespace` o `contentBase64`',
  })
  public async checkParser(
    @Body(STRICT_VALIDATION) checkParserDto: CheckParserDto,
  ): Promise<CheckParserResponseDto> {
    return this.wizardService.checkParser(checkParserDto);
  }

  /**
   * Extrae un articulo de una URL real con la misma logica del nodo EXTRACTOR_WEB.
   *
   * `HttpStatus.OK` por el mismo motivo que los dos anteriores: no se crea
   * ningun recurso, se devuelve el resultado de una comprobacion, y nada
   * persiste mas alla de la peticion.
   *
   * AVISO DE SEGURIDAD: a diferencia de `check-parser`, este endpoint SI es un
   * oraculo de red. Acepta una URL arbitraria y navega a ella desde el servidor,
   * de modo que un EDITOR autenticado puede usarlo para sondear hosts internos
   * (`http://intranet/...`) que no serian alcanzables desde su puesto. Lo que lo
   * contiene son las tres barreras de esta clase —lista blanca de IP perimetral,
   * JWT y rol— mas la lista blanca de esquemas del DTO, que cierra `file:` y
   * `data:`. Es la misma exposicion que ya asume `check-imap`, y merece la misma
   * franqueza: quien pueda llamar aqui puede mapear la red del servidor.
   */
  @Post('check-scraper')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Extrae un articulo de una URL de prueba',
    description:
      'Recorre la MISMA navegacion, deteccion de bloqueo y extraccion que ejecutara el nodo EXTRACTOR_WEB, y devuelve lo que depositaria en el namespace `scraped_web`. Un portal caido o un muro de pago se devuelven como 200 con `success: false`, no como error de la peticion.',
  })
  @ApiOkResponse({
    description:
      'Resultado de la extraccion. `success: false` describe el diagnostico del portal',
    type: CheckScraperResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'Cuerpo invalido: `targetUrl` no es una URL http/https absoluta —las plantillas `{{...}}` se rechazan aqui, porque el banco de pruebas no tiene contexto que interpolar—, un parametro esta fuera de rango, o se envio una propiedad no permitida',
  })
  public async checkScraper(
    @Body(STRICT_VALIDATION) checkScraperDto: CheckScraperDto,
  ): Promise<CheckScraperResponseDto> {
    return this.wizardService.checkScraper(checkScraperDto);
  }
}
