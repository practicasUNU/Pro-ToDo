import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { UserRole } from '@modules/users/enums/user-role.enum';

import { CreateWorkflowTemplateDto } from './dto/create-workflow-template.dto';
import { UpdateWorkflowTemplateDto } from './dto/update-workflow-template.dto';
import { WorkflowTemplatesService } from './workflow-templates.service';

import type {
  WorkflowTemplateDetailResponseDto,
  WorkflowTemplateResponseDto,
} from './dto/workflow-template-response.dto';

/**
 * Catalogo de plantillas de flujo (blueprints maestros).
 *
 * REPARTO DE ROLES, y es la diferencia con `TemplatesController`: la LECTURA la
 * necesita un EDITOR —el selector de la Fase 0 del asistente es suyo—, pero las
 * ESCRITURAS son de ADMIN. Redefinir el maestro del que parten todos los flujos
 * es mas poderoso que editar un flujo suelto: cambiar la topologia base decide
 * que nodos existen en cada flujo que alguien cree despues.
 *
 * El `@Roles` de metodo gana al de clase porque `RolesGuard` resuelve con
 * `getAllAndOverride`. Los guards se declaran igualmente a nivel de clase para
 * que un endpoint futuro no quede desprotegido por olvido (Poka-Yoke); el
 * perimetro de red lo cubre aparte `IpWhitelistGuard`, global en `AppModule`.
 */
@ApiTags('workflow-templates')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, expirado o invalido' })
@ApiForbiddenResponse({
  description: 'IP fuera de la red corporativa o rol insuficiente',
})
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.EDITOR)
@Controller('workflow-templates')
export class WorkflowTemplatesController {
  constructor(
    private readonly workflowTemplatesService: WorkflowTemplatesService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Lista las plantillas con su topologia en orden de ejecucion',
  })
  @ApiQuery({
    name: 'includeInactive',
    required: false,
    description:
      'Incluye las plantillas retiradas. Para la tabla administrativa; el selector del asistente las omite',
  })
  public async findAll(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<WorkflowTemplateResponseDto[]> {
    // Se exige el literal "true" y no una conversion laxa: un query param mal
    // escrito debe caer del lado seguro, que es no mostrar las retiradas.
    return this.workflowTemplatesService.findAll(includeInactive !== 'true');
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Obtiene una plantilla con su pipeline_schema completo',
  })
  @ApiNotFoundResponse({
    description: 'No existe ninguna plantilla con ese id',
  })
  public async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WorkflowTemplateDetailResponseDto> {
    return this.workflowTemplatesService.findOne(id);
  }

  // Solo ADMIN: define la topologia base de todos los flujos que partan de ella.
  @Post()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Crea una plantilla validando su grafo completo' })
  @ApiBadRequestResponse({
    description:
      'El grafo no pasa la validacion: forma, tipos o integridad de la topologia',
  })
  @ApiConflictResponse({
    description: 'Ya existe una plantilla con ese nombre',
  })
  public async create(
    @Body() createDto: CreateWorkflowTemplateDto,
  ): Promise<WorkflowTemplateDetailResponseDto> {
    return this.workflowTemplatesService.create(createDto);
  }

  @Put(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Actualiza una plantilla; tambien la activa o la inactiva',
  })
  @ApiBadRequestResponse({
    description: 'El grafo nuevo no pasa la validacion',
  })
  @ApiConflictResponse({
    description: 'Otra plantilla ya usa el nombre indicado',
  })
  @ApiNotFoundResponse({
    description: 'No existe ninguna plantilla con ese id',
  })
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateDto: UpdateWorkflowTemplateDto,
  ): Promise<WorkflowTemplateDetailResponseDto> {
    return this.workflowTemplatesService.update(id, updateDto);
  }

  // Borrado logico: los flujos instanciados apuntan a esta fila con
  // `id_plantilla_origen` y su trazabilidad depende de que siga existiendo.
  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Retira una plantilla del catalogo (borrado logico)',
  })
  @ApiNotFoundResponse({
    description: 'No existe ninguna plantilla con ese id',
  })
  public async remove(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WorkflowTemplateDetailResponseDto> {
    return this.workflowTemplatesService.softDelete(id);
  }
}
