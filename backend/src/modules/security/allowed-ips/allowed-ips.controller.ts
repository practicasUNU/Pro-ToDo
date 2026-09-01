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

import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { UserRole } from '@modules/users/enums/user-role.enum';

import { AllowedIpsService } from './allowed-ips.service';
import { CreateAllowedIpDto } from './dto/create-allowed-ip.dto';
import { UpdateAllowedIpDto } from './dto/update-allowed-ip.dto';

import type { AllowedIp } from './entities/allowed-ip.entity';

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
  public async findAll(): Promise<AllowedIp[]> {
    return this.allowedIpsService.findAll();
  }

  @Post()
  @ApiOperation({ summary: 'Registra una nueva IP/CIDR autorizada' })
  public async create(
    @Body() createAllowedIpDto: CreateAllowedIpDto,
  ): Promise<AllowedIp> {
    return this.allowedIpsService.create(createAllowedIpDto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Actualiza la IP/CIDR o descripcion de un registro',
  })
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateAllowedIpDto: UpdateAllowedIpDto,
  ): Promise<AllowedIp> {
    return this.allowedIpsService.update(id, updateAllowedIpDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Elimina una IP/CIDR autorizada' })
  public async remove(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AllowedIp> {
    return this.allowedIpsService.remove(id);
  }
}
