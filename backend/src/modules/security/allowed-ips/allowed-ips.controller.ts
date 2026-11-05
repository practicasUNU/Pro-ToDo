import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { AuditTable } from '@modules/audit/audit-tables';
import { AuditAction } from '@modules/audit/decorators/audit-action.decorator';
import { AuditActionType } from '@modules/audit/enums/audit-action.enum';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { UserRole } from '@modules/users/enums/user-role.enum';

import { AllowedIpsService } from './allowed-ips.service';
import {
  AllowedIpResponseDto,
  toAllowedIpResponse,
} from './dto/allowed-ip-response.dto';
import { CreateAllowedIpDto } from './dto/create-allowed-ip.dto';
import { UpdateAllowedIpDto } from './dto/update-allowed-ip.dto';

import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';

/**
 * CRUD de la lista blanca de IPs/CIDR autorizadas (PROT-05), reservado en
 * exclusiva al rol ADMIN. Los guards se declaran a nivel de clase para que
 * ningun endpoint futuro quede desprotegido por olvido (Poka-Yoke).
 */
@ApiTags('allowed-ips')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, expirado o invalido' })
@ApiForbiddenResponse({
  description: 'IP fuera de la red corporativa o rol distinto de ADMIN',
})
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('allowed-ips')
export class AllowedIpsController {
  constructor(private readonly allowedIpsService: AllowedIpsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista todas las IPs/CIDR autorizadas' })
  public async findAll(): Promise<AllowedIpResponseDto[]> {
    const entries = await this.allowedIpsService.findAll();
    return entries.map(toAllowedIpResponse);
  }

  @Post()
  @AuditAction({
    table: AuditTable.ALLOWED_IPS,
    action: AuditActionType.CREATE,
  })
  @ApiOperation({ summary: 'Registra una nueva IP/CIDR autorizada' })
  public async create(
    @Body() createAllowedIpDto: CreateAllowedIpDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<AllowedIpResponseDto> {
    return toAllowedIpResponse(
      await this.allowedIpsService.create(createAllowedIpDto, currentUser.id),
    );
  }

  @Patch(':id')
  @AuditAction({
    table: AuditTable.ALLOWED_IPS,
    action: AuditActionType.UPDATE,
  })
  @ApiOperation({
    summary: 'Actualiza la IP/CIDR o descripcion de un registro',
  })
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateAllowedIpDto: UpdateAllowedIpDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<AllowedIpResponseDto> {
    return toAllowedIpResponse(
      await this.allowedIpsService.update(
        id,
        updateAllowedIpDto,
        currentUser.id,
      ),
    );
  }

  @Delete(':id')
  @AuditAction({
    table: AuditTable.ALLOWED_IPS,
    action: AuditActionType.DELETE,
  })
  @ApiOperation({ summary: 'Elimina una IP/CIDR autorizada' })
  public async remove(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AllowedIpResponseDto> {
    return toAllowedIpResponse(await this.allowedIpsService.remove(id));
  }
}
