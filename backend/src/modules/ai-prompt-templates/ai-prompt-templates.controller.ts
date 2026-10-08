import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { UserRole } from '@modules/users/enums/user-role.enum';

import { AiPromptTemplatesService } from './ai-prompt-templates.service';
import { CreateAiPromptTemplateDto } from './dto/create-ai-prompt-template.dto';
import { UpdateAiPromptTemplateDto } from './dto/update-ai-prompt-template.dto';

import type {
  AiPromptTemplateDetailResponseDto,
  AiPromptTemplateResponseDto,
} from './dto/ai-prompt-template-response.dto';
import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';

/**
 * CRUD de prompts de IA (PROT-15.2), abierto a ADMIN y EDITOR.
 *
 * Curar prompts es operacion de flujos y no gestion de cuentas, que es la unica
 * frontera que `security-and-scope.md` §2 reserva al ADMIN.
 *
 * Los guards se declaran a nivel de clase para que ningun endpoint futuro quede
 * desprotegido por olvido (Poka-Yoke). El perimetro de red lo cubre aparte
 * `IpWhitelistGuard`, registrado como guard global en `AppModule`.
 */
@ApiTags('ai-prompt-templates')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, expirado o invalido' })
@ApiForbiddenResponse({
  description: 'IP fuera de la red corporativa o rol distinto de ADMIN/EDITOR',
})
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.EDITOR)
@Controller('ai-prompt-templates')
export class AiPromptTemplatesController {
  constructor(
    private readonly aiPromptTemplatesService: AiPromptTemplatesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Lista los prompts; por defecto solo los activos' })
  @ApiQuery({
    name: 'includeInactive',
    required: false,
    description:
      'Incluye los prompts retirados. Para la tabla administrativa; el selector del nodo IA los omite',
  })
  public async findAll(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<AiPromptTemplateResponseDto[]> {
    // Se exige el literal "true" y no una conversion laxa: un query param mal
    // escrito debe caer del lado seguro, que es no mostrar los retirados.
    return this.aiPromptTemplatesService.findAll(includeInactive !== 'true');
  }

  /**
   * Resolucion por clave de maquina.
   *
   * VA ANTES de `@Get(':id')` y eso es obligatorio, no estilistico: Nest casa
   * las rutas en orden de declaracion, asi que con el orden inverso
   * `/code/LICITACION_APERTURA_DEFAULT` entraria por `:id`, el `ParseUUIDPipe` veria
   * "code" y devolveria un 400 en lugar del prompt.
   */
  @Get('code/:code')
  @ApiOperation({
    summary: 'Obtiene un prompt por su codigo inmutable',
    description:
      'Resolucion que usan el asistente y la FSM: el codigo sobrevive a un clonado ' +
      'de la base y a un renombrado de la etiqueta visible, el UUID y el nombre no.',
  })
  @ApiNotFoundResponse({
    description: 'No existe ningun prompt con ese codigo',
  })
  public async findOneByCode(
    @Param('code') code: string,
  ): Promise<AiPromptTemplateDetailResponseDto> {
    return this.aiPromptTemplatesService.findOneByCode(code);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtiene un prompt con su instruccion completa' })
  @ApiNotFoundResponse({ description: 'No existe ningun prompt con ese id' })
  public async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AiPromptTemplateDetailResponseDto> {
    return this.aiPromptTemplatesService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Registra un prompt reutilizable' })
  @ApiBadRequestResponse({
    description: 'El cuerpo no supera la validacion del DTO',
  })
  @ApiConflictResponse({ description: 'Ya existe un prompt con ese nombre' })
  public async create(
    @Body() createAiPromptTemplateDto: CreateAiPromptTemplateDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<AiPromptTemplateDetailResponseDto> {
    // La autoria se toma del token, nunca del cuerpo: asi no se puede suplantar.
    return this.aiPromptTemplatesService.create(
      createAiPromptTemplateDto,
      currentUser.id,
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualiza parcialmente un prompt' })
  @ApiBadRequestResponse({
    description: 'El cuerpo no supera la validacion del DTO',
  })
  @ApiConflictResponse({ description: 'Ya existe otro prompt con ese nombre' })
  @ApiNotFoundResponse({ description: 'No existe ningun prompt con ese id' })
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateAiPromptTemplateDto: UpdateAiPromptTemplateDto,
  ): Promise<AiPromptTemplateDetailResponseDto> {
    return this.aiPromptTemplatesService.update(id, updateAiPromptTemplateDto);
  }

  // Borrado logico: preserva la trazabilidad de las ejecuciones que lo usaron.
  @Delete(':id')
  @ApiOperation({ summary: 'Retira un prompt (borrado logico)' })
  @ApiNotFoundResponse({ description: 'No existe ningun prompt con ese id' })
  public async remove(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AiPromptTemplateDetailResponseDto> {
    return this.aiPromptTemplatesService.softDelete(id);
  }
}
