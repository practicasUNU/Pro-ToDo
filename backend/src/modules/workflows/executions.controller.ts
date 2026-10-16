import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { toIssueContractException } from '@core/fsm/utils/schema-issue-contract.util';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { UserRole } from '@modules/users/enums/user-role.enum';

import { DiscardExecutionResponseDto } from './dto/discard-execution-response.dto';
import { ExecutionDetailResponseDto } from './dto/execution-detail-response.dto';
import { ExecutionPageResponseDto } from './dto/execution-summary-response.dto';
import { ListExecutionsQueryDto } from './dto/list-executions-query.dto';
import { ResumeExecutionDto } from './dto/resume-execution.dto';
import { WorkflowExecutionResponseDto } from './dto/workflow-execution-response.dto';
import { ExecutionsService } from './executions.service';

import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';

/**
 * Superficie HTTP de la trazabilidad de ejecuciones y del reintento manual.
 *
 * Doble barrera, igual que `WorkflowsController`: la ruta no lleva
 * `@PublicIp()`, de modo que el `IpWhitelistGuard` global (PROT-05) la cubre, y
 * ademas exige JWT y rol. Abierta a ADMIN y EDITOR porque operar y auditar
 * flujos es competencia del EDITOR (`security-and-scope.md` §2); reservar la
 * reanudacion al ADMIN significaria que quien construyo el flujo no puede
 * desatascarlo.
 *
 * Los guards y los roles se declaran a nivel de CLASE para que ningun endpoint
 * que se anada despues quede desprotegido por olvido (Poka-Yoke).
 */
@ApiTags('executions')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, expirado o invalido' })
@ApiForbiddenResponse({
  description: 'IP fuera de la red corporativa o rol distinto de ADMIN/EDITOR',
})
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.EDITOR)
@Controller('executions')
export class ExecutionsController {
  constructor(private readonly executionsService: ExecutionsService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista las ejecuciones con sus filtros, sin el contexto acumulado',
  })
  @ApiOkResponse({
    description:
      'Pagina de ejecuciones. El contexto acumulado NO viaja aqui: pidelo en el detalle',
    type: ExecutionPageResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'Algun filtro no es valido (estado inexistente, limite fuera de rango)',
  })
  public async findAll(
    @Query() listExecutionsQueryDto: ListExecutionsQueryDto,
  ): Promise<ExecutionPageResponseDto> {
    return this.executionsService.findAll(listExecutionsQueryDto);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Devuelve una ejecucion con su checkpoint completo',
  })
  @ApiOkResponse({
    description: 'La ejecucion, incluido `contexto_acumulado`',
    type: ExecutionDetailResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'No existe ninguna ejecucion con ese id',
  })
  public async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ExecutionDetailResponseDto> {
    return this.executionsService.findOne(id);
  }

  /**
   * Reintento manual de una ejecucion detenida (CU-09).
   *
   * `HttpStatus.OK` y no el 201 por defecto de `@Post`: no se crea ningun
   * recurso. La reanudacion reutiliza la MISMA fila de `ejecuciones_flujo`, asi
   * que el historico no crece con cada intento.
   *
   * La peticion es SINCRONA, igual que el banco de pruebas: no retorna hasta
   * que el motor alcanza un estado terminal, lo que con un pipeline largo puede
   * tardar minutos.
   */
  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Reanuda una ejecucion PAUSADO desde el nodo en el que se detuvo, conservando su contexto acumulado',
  })
  @ApiOkResponse({
    description:
      'El motor alcanzo un estado terminal; se devuelve el checkpoint resultante con el mismo executionId',
    type: WorkflowExecutionResponseDto,
  })
  @ApiNotFoundResponse({
    description:
      'No existe la ejecucion, o el flujo que la origino fue borrado',
  })
  @ApiConflictResponse({
    description:
      'La ejecucion no esta PAUSADO, o esta PAUSADO pero perdio el paso en el que se detuvo',
  })
  @ApiBadRequestResponse({
    description:
      'El esquema del flujo ya no supera el validador, o el nodo del cursor se elimino al editarlo',
  })
  @ApiTooManyRequestsResponse({
    description:
      'El motor ya atiende el maximo de ejecuciones simultaneas: reintentalo cuando alguna termine',
  })
  public async resume(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() resumeExecutionDto: ResumeExecutionDto,
    // El usuario se recoge para dejar constancia de QUIEN desatasco el flujo:
    // una reanudacion es una intervencion manual sobre datos reales, y la
    // traza de operacion no debe ser anonima.
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<WorkflowExecutionResponseDto> {
    try {
      // `await` dentro del `try`, y no un `return` de la promesa: sin el, el
      // rechazo escapa de este bloque y los issues del validador volverian a
      // salir crudos. Mismo criterio que `WorkflowsController`.
      // El usuario ENTERO y no solo su identificador: el aviso en tiempo real
      // lo nombra por su correo, y antes imprimia un UUID crudo pese a que el
      // dato legible venia en el mismo JWT.
      return await this.executionsService.resumeExecution(
        id,
        resumeExecutionDto,
        currentUser,
      );
    } catch (error: unknown) {
      throw toIssueContractException(error);
    }
  }

  /**
   * Cierre manual de una ejecucion detenida (CU-09).
   *
   * `HttpStatus.OK` y no el `204` habitual de un `@Delete`: la respuesta lleva
   * cuerpo, porque el descarte toca DOS filas —la ejecucion y su flujo, que
   * queda retirado de los disparadores— y un cliente que solo recibiera un
   * acuse pintaria el flujo como activo hasta la siguiente recarga.
   *
   * `@Delete` y no `@Post` pese a no borrar ninguna fila: el recurso que la
   * ejecucion representaba —un trabajo pendiente de reanudar— deja de existir,
   * que es exactamente lo que el verbo significa para el cliente.
   */
  @Delete(':id/discard')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Descarta una ejecucion PAUSADO y retira su flujo de los disparadores automaticos',
  })
  @ApiOkResponse({
    description:
      'La ejecucion quedo en DESCARTADO y sin cursor; se devuelve ademas el flujo ya desactivado',
    type: DiscardExecutionResponseDto,
  })
  @ApiNotFoundResponse({
    description:
      'No existe la ejecucion, o el flujo que la origino fue borrado',
  })
  @ApiConflictResponse({
    description: 'La ejecucion no esta PAUSADO: no hay nada que descartar',
  })
  public async discard(
    @Param('id', ParseUUIDPipe) id: string,
    // Mismo motivo que en `resume`: descartar es una intervencion manual sobre
    // datos reales, y su traza no puede ser anonima.
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<DiscardExecutionResponseDto> {
    return this.executionsService.discardExecution(id, currentUser.id);
  }
}
