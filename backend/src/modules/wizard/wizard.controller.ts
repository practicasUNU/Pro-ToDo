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
}
