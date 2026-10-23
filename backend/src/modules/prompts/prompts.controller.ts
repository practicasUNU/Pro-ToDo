import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { OTP_THROTTLER_NAME } from '@common/constants/throttler.constants';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import {
  OptimizePromptDto,
  OptimizePromptResponseDto,
} from '@modules/prompts/dto/optimize-prompt.dto';
import { PromptOptimizerService } from '@modules/prompts/prompt-optimizer.service';
import { UserRole } from '@modules/users/enums/user-role.enum';

import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';

/**
 * Freno de gasto: cada llamada es una inferencia de pago. Diez por minuto
 * cubren de sobra a quien itera sobre un prompt y cortan un bucle (o un doble
 * clic insistente) antes de que se note en la factura.
 */
const OPTIMIZE_THROTTLE = { [OTP_THROTTLER_NAME]: { limit: 10, ttl: 60_000 } };

/**
 * Asistente de prompts con IA. ADMIN y EDITOR: ambos curan plantillas de prompt
 * y configuran nodos. Los guards van a nivel de clase para que ningun endpoint
 * futuro quede abierto por olvido.
 */
@ApiTags('prompts')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, expirado o invalido' })
@ApiForbiddenResponse({
  description: 'IP fuera de la red corporativa o modelo reservado a ADMIN',
})
@UseGuards(JwtAuthGuard, RolesGuard, ThrottlerGuard)
@Roles(UserRole.ADMIN, UserRole.EDITOR)
@Controller('prompts')
export class PromptsController {
  constructor(private readonly promptOptimizer: PromptOptimizerService) {}

  @Post('optimize')
  @HttpCode(HttpStatus.OK)
  @Throttle(OPTIMIZE_THROTTLE)
  @ApiOperation({
    summary:
      'Reescribe un borrador de prompt con reglas de Prompt Engineering y registra su coste',
  })
  @ApiOkResponse({ type: OptimizePromptResponseDto })
  @ApiServiceUnavailableResponse({
    description: 'No hay proveedor de IA real con credencial',
  })
  @ApiBadGatewayResponse({ description: 'El proveedor de IA fallo' })
  @ApiTooManyRequestsResponse({
    description: 'Limite de optimizaciones excedido',
  })
  public async optimize(
    @Body() dto: OptimizePromptDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<OptimizePromptResponseDto> {
    return this.promptOptimizer.optimize(dto, currentUser);
  }
}
