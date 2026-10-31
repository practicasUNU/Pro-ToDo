import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { DrupalApiConfig } from '@core/config/drupal-api.config';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import {
  DrupalPresetTargetDto,
  DrupalPresetTargetsResponseDto,
} from '@modules/nodes/dto/drupal-preset-targets.dto';
import { UserRole } from '@modules/users/enums/user-role.enum';

/**
 * Paginas de los destinos rapidos del nodo Drupal (`GET /api/nodos/drupal/targets`).
 *
 * Existe para que los UUID vivan en UN sitio, el `.env` del backend, y no
 * copiados a mano en el cliente: el mismo dato servia de lista blanca del Banco
 * de Pruebas aqui y de constante alli, y cambiar una pagina obligaba a tocar los
 * dos. Mismo perimetro que el resto de `/nodos`: ADMIN y EDITOR, de solo
 * lectura. Se lee del entorno en cada peticion, como `/llm/models`: una pagina
 * anadida al `.env` vale tras reiniciar, sin desplegar.
 */
@ApiTags('nodos')
@ApiBearerAuth()
@ApiExtraModels(DrupalPresetTargetDto)
@ApiUnauthorizedResponse({ description: 'Token ausente, expirado o invalido' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.EDITOR)
@Controller('nodos/drupal')
export class DrupalTargetsController {
  constructor(private readonly drupalApiConfig: DrupalApiConfig) {}

  @Get('targets')
  @ApiOperation({
    summary: 'Paginas de pruebas y del portal de cada destino rapido Drupal',
  })
  @ApiOkResponse({
    description:
      'Por entorno y preset. Una pagina no declarada, o mal escrita en el entorno, llega a null',
    type: DrupalPresetTargetsResponseDto,
  })
  public findTargets(): DrupalPresetTargetsResponseDto {
    return this.drupalApiConfig.presetTargets;
  }
}
