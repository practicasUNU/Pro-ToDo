import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { OTP_THROTTLER_NAME } from '@common/constants/throttler.constants';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { extractClientIp } from '@common/utils/client-ip.util';
import { Roles } from '@common/decorators/roles.decorator';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { NodeSandboxResultDto } from '@modules/nodes/sandbox/dto/node-sandbox-result.dto';
import { RunNodeSandboxDto } from '@modules/nodes/sandbox/dto/run-node-sandbox.dto';
import {
  SANDBOX_THROTTLE_LIMIT,
  SANDBOX_THROTTLE_TTL_MS,
} from '@modules/nodes/sandbox/node-sandbox.constants';
import { NodeSandboxService } from '@modules/nodes/sandbox/node-sandbox.service';
import { UserRole } from '@modules/users/enums/user-role.enum';

import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';
import type { Request } from 'express';

/**
 * Banco de pruebas: ejecucion aislada de un nodo.
 *
 * La clase admite ADMIN y EDITOR, pero el rol EFECTIVO se decide por tipo de
 * nodo en `NodeSandboxService` (`SANDBOX_ROLES_BY_NODE_TYPE`): IA y OCR solo
 * ADMIN, HTTP generico tambien EDITOR.
 *
 * Con limite de tasa propio: cada llamada es una inferencia facturada o una
 * peticion real a un tercero. Reutiliza el unico throttler declarado en
 * `ThrottlerModule` con una cuota mas holgada, igual que las rutas de sesion.
 */
@ApiTags('nodes')
@ApiBearerAuth()
@ApiForbiddenResponse({
  description: 'Rol no autorizado para ese tipo de nodo, o IP fuera de la red',
})
@UseGuards(JwtAuthGuard, RolesGuard, ThrottlerGuard)
@Roles(UserRole.ADMIN, UserRole.EDITOR)
@Controller('nodes/sandbox')
export class NodeSandboxController {
  constructor(private readonly nodeSandboxService: NodeSandboxService) {}

  /**
   * `@HttpCode(OK)`: no se crea nada. Un fallo DEL NODO sale como 200 con
   * `success: false`, porque averiguar si falla es justo lo que se prueba;
   * solo un tipo no ejecutable, un rol sin permiso o unos params invalidos son
   * errores de la peticion.
   */
  @Post('run')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    [OTP_THROTTLER_NAME]: {
      limit: SANDBOX_THROTTLE_LIMIT,
      ttl: SANDBOX_THROTTLE_TTL_MS,
    },
  })
  @ApiOperation({
    summary: 'Ejecuta un nodo aislado con datos simulados',
    description:
      'AVISO: PROCESADOR_IA y PROCESADOR_OCR facturan tokens reales; DESTINO_HTTP_GENERICO envia la peticion de verdad.',
  })
  @ApiOkResponse({ type: NodeSandboxResultDto })
  @ApiTooManyRequestsResponse({ description: 'Limite de pruebas excedido' })
  public async run(
    @Body() runNodeSandboxDto: RunNodeSandboxDto,
    @CurrentUser() currentUser: AuthenticatedUser,
    // La IP va al evento `PRUEBA_NODO` de `audit_eventos`.
    @Req() request: Request,
  ): Promise<NodeSandboxResultDto> {
    return this.nodeSandboxService.run(runNodeSandboxDto, currentUser, {
      sourceIp: extractClientIp(request),
    });
  }
}
