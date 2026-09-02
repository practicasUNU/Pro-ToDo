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
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { UserRole } from '@modules/users/enums/user-role.enum';

import { CreateTemplateDto } from './dto/create-template.dto';
import { PreviewTemplateDto } from './dto/preview-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { TemplatesService } from './templates.service';

import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';
import type { HtmlTemplate } from './entities/html-template.entity';

/**
 * Gestor de plantillas HTML (PROT-11.1), abierto a ADMIN y EDITOR: configurar
 * plantillas es operacion de flujos, no gestion de cuentas.
 *
 * Los guards se declaran a nivel de clase para que ningun endpoint futuro quede
 * desprotegido por olvido (Poka-Yoke). El perimetro de red lo cubre aparte
 * `IpWhitelistGuard`, registrado como guard global en `AppModule`.
 *
 * Se devuelve la entidad cruda y no un DTO de respuesta: a diferencia de
 * `usuarios`, aqui no hay ninguna columna que deba quedar oculta.
 */
@ApiTags('templates')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, expirado o invalido' })
@ApiForbiddenResponse({
  description: 'IP fuera de la red corporativa o rol distinto de ADMIN/EDITOR',
})
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.EDITOR)
@Controller('templates')
export class TemplatesController {
  constructor(private readonly templatesService: TemplatesService) {}

  @Get()
  @ApiOperation({ summary: 'Lista las plantillas activas' })
  public async findAll(): Promise<HtmlTemplate[]> {
    return this.templatesService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtiene una plantilla por su identificador' })
  @ApiNotFoundResponse({
    description: 'No existe ninguna plantilla con ese id',
  })
  public async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<HtmlTemplate> {
    return this.templatesService.findOne(id);
  }

  @Post()
  @ApiOperation({
    summary:
      'Crea una plantilla validando sus variables contra la lista blanca',
  })
  @ApiBadRequestResponse({
    description:
      'La plantilla referencia un namespace desconocido o usa sintaxis no permitida',
  })
  public async create(
    @Body() createTemplateDto: CreateTemplateDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<HtmlTemplate> {
    // La autoria se toma del token, nunca del cuerpo: asi no se puede suplantar.
    return this.templatesService.create(createTemplateDto, currentUser.id);
  }

  @Put(':id')
  @ApiOperation({
    summary: 'Actualiza una plantilla y recalcula sus variables requeridas',
  })
  @ApiBadRequestResponse({
    description:
      'El nuevo HTML referencia un namespace desconocido o usa sintaxis no permitida',
  })
  @ApiNotFoundResponse({
    description: 'No existe ninguna plantilla con ese id',
  })
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateTemplateDto: UpdateTemplateDto,
  ): Promise<HtmlTemplate> {
    return this.templatesService.update(id, updateTemplateDto);
  }

  @Post(':id/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Compila la plantilla contra un payload simulado (vista previa)',
  })
  @ApiBadRequestResponse({
    description: 'La plantilla no compila o referencia variables irresolubles',
  })
  @ApiNotFoundResponse({
    description: 'No existe ninguna plantilla con ese id',
  })
  public async preview(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() previewTemplateDto: PreviewTemplateDto,
  ): Promise<{ compiledMarkup: string }> {
    // 200 y no 201: no se crea ningun recurso, es una consulta con cuerpo.
    return this.templatesService.previewTemplate(id, previewTemplateDto);
  }

  // Borrado logico: preserva la trazabilidad de las ejecuciones que la usaron
  @Delete(':id')
  @ApiOperation({ summary: 'Desactiva una plantilla (borrado logico)' })
  @ApiNotFoundResponse({
    description: 'No existe ninguna plantilla con ese id',
  })
  public async remove(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<HtmlTemplate> {
    return this.templatesService.softDelete(id);
  }
}
