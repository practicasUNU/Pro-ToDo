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

import { AiPromptsService } from './ai-prompts.service';
import { CreateAiPromptDto } from './dto/create-ai-prompt.dto';
import { UpdateAiPromptDto } from './dto/update-ai-prompt.dto';

import type {
  AiPromptDetailResponseDto,
  AiPromptResponseDto,
} from './dto/ai-prompt-response.dto';
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
@ApiTags('ai-prompts')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, expirado o invalido' })
@ApiForbiddenResponse({
  description: 'IP fuera de la red corporativa o rol distinto de ADMIN/EDITOR',
})
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.EDITOR)
@Controller('ai-prompts')
export class AiPromptsController {
  constructor(private readonly aiPromptsService: AiPromptsService) {}

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
  ): Promise<AiPromptResponseDto[]> {
    // Se exige el literal "true" y no una conversion laxa: un query param mal
    // escrito debe caer del lado seguro, que es no mostrar los retirados.
    return this.aiPromptsService.findAll(includeInactive !== 'true');
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtiene un prompt con su instruccion completa' })
  @ApiNotFoundResponse({ description: 'No existe ningun prompt con ese id' })
  public async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AiPromptDetailResponseDto> {
    return this.aiPromptsService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Registra un prompt reutilizable' })
  @ApiBadRequestResponse({
    description: 'El cuerpo no supera la validacion del DTO',
  })
  @ApiConflictResponse({ description: 'Ya existe un prompt con ese nombre' })
  public async create(
    @Body() createAiPromptDto: CreateAiPromptDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<AiPromptDetailResponseDto> {
    // La autoria se toma del token, nunca del cuerpo: asi no se puede suplantar.
    return this.aiPromptsService.create(createAiPromptDto, currentUser.id);
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
    @Body() updateAiPromptDto: UpdateAiPromptDto,
  ): Promise<AiPromptDetailResponseDto> {
    return this.aiPromptsService.update(id, updateAiPromptDto);
  }

  // Borrado logico: preserva la trazabilidad de las ejecuciones que lo usaron.
  @Delete(':id')
  @ApiOperation({ summary: 'Retira un prompt (borrado logico)' })
  @ApiNotFoundResponse({ description: 'No existe ningun prompt con ese id' })
  public async remove(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AiPromptDetailResponseDto> {
    return this.aiPromptsService.softDelete(id);
  }
}
