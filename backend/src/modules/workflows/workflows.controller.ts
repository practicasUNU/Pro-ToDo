import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
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
import { UserRole } from '@modules/users/enums/user-role.enum';

import { RunWorkflowTestDto } from './dto/run-workflow-test.dto';
import { WorkflowExecutionResponseDto } from './dto/workflow-execution-response.dto';
import { WorkflowsService } from './workflows.service';

/**
 * Superficie HTTP de operacion de flujos.
 *
 * Doble barrera, igual que `TemplatesController`: la ruta no lleva `@PublicIp()`,
 * de modo que el `IpWhitelistGuard` global (PROT-05) la cubre, y ademas exige
 * JWT y rol. Abierta a ADMIN y EDITOR porque operar y auditar flujos es
 * competencia del EDITOR (`security-and-scope.md` §2); la gestion de cuentas es
 * lo unico reservado al ADMIN.
 *
 * Los guards y los roles se declaran a nivel de CLASE para que ningun endpoint
 * que se anada despues quede desprotegido por olvido (Poka-Yoke).
 */
@ApiTags('workflows')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, expirado o invalido' })
@ApiForbiddenResponse({
  description: 'IP fuera de la red corporativa o rol distinto de ADMIN/EDITOR',
})
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.EDITOR)
@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflowsService: WorkflowsService) {}

  /**
   * Despacho manual de un flujo (Camino B).
   *
   * `HttpStatus.OK` y no el 201 que Nest asigna por defecto a `@Post`: el
   * recurso que interesa al cliente no es la fila creada en `ejecuciones_flujo`,
   * sino el RESULTADO del recorrido, que se devuelve en el mismo cuerpo. La
   * peticion es sincrona: no retorna hasta que el motor alcanza un estado
   * terminal (EXITOSO, PAUSADO o FALLIDO).
   */
  @Post(':id/run-test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Dispara un flujo completo sembrando el contexto a mano, sin el listener IMAP',
  })
  @ApiOkResponse({
    description:
      'El motor alcanzo un estado terminal; se devuelve el checkpoint',
    type: WorkflowExecutionResponseDto,
  })
  @ApiNotFoundResponse({ description: 'No existe ningun flujo con ese id' })
  @ApiBadRequestResponse({
    description:
      'El flujo no tiene configuracion_pipeline, o su esquema no supera PipelineValidatorService',
  })
  @ApiConflictResponse({
    description:
      'Conflicto de concurrencia (RNF-09): el flujo ya tiene una ejecucion EN_PROCESO',
  })
  public async runWorkflowTest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() runWorkflowTestDto: RunWorkflowTestDto,
  ): Promise<WorkflowExecutionResponseDto> {
    return this.workflowsService.runWorkflowTest(id, runWorkflowTestDto);
  }
}
