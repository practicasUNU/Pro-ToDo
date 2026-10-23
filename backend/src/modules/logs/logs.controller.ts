import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { ExecutionLogResponseDto } from '@modules/logs/dto/execution-log-response.dto';
import { ExecutionLogReaderService } from '@modules/logs/services/execution-log-reader.service';
import { UserRole } from '@modules/users/enums/user-role.enum';

/**
 * Lectura de las trazas de ejecucion para el visor del panel.
 *
 * ADMIN y EDITOR, igual que `/executions`: inspeccionar por que fallo un flujo
 * es parte de operarlo. Guards a nivel de clase para que ningun endpoint futuro
 * quede abierto por olvido.
 */
@ApiTags('logs')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, expirado o invalido' })
@ApiForbiddenResponse({
  description: 'IP fuera de la red corporativa o rol no autorizado',
})
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.EDITOR)
@Controller('logs')
export class LogsController {
  constructor(private readonly logReader: ExecutionLogReaderService) {}

  @Get('execution/:executionId')
  @ApiOperation({
    summary:
      'Traza de una ejecucion: ultimo fallo y sus entradas en los ficheros .log',
  })
  @ApiOkResponse({ type: ExecutionLogResponseDto })
  @ApiNotFoundResponse({ description: 'No existe la ejecucion' })
  public async getExecutionLog(
    @Param('executionId', ParseUUIDPipe) executionId: string,
  ): Promise<ExecutionLogResponseDto> {
    return this.logReader.readExecutionLog(executionId);
  }
}
