import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { extractClientIp } from '@common/utils/client-ip.util';
import { AuditTable } from '@modules/audit/audit-tables';
import { AuditAction } from '@modules/audit/decorators/audit-action.decorator';
import { AuditActionType } from '@modules/audit/enums/audit-action.enum';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { UserRole } from '@modules/users/enums/user-role.enum';

import { CreatePricingDto } from './dto/create-pricing.dto';
import { ListPricingQueryDto } from './dto/list-pricing-query.dto';
import { PricingService } from './pricing.service';

import type {
  PricingPageResponseDto,
  PricingResponseDto,
} from './dto/pricing-response.dto';
import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';
import type { Request } from 'express';

/**
 * Tarifas de modelos de IA, reservadas en exclusiva al rol ADMIN.
 *
 * Solo dos rutas, a proposito: NO existe `PATCH`, `DELETE` ni ninguna forma
 * de desactivar una tarifa por separado. Modificar una tarifa es registrar la
 * siguiente (`POST`), y el servicio pasa la anterior a historico en la misma
 * transaccion; asi un par nunca se queda sin tarifa vigente.
 */
@ApiTags('pricing')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, expirado o invalido' })
@ApiForbiddenResponse({
  description: 'IP fuera de la red corporativa o rol distinto de ADMIN',
})
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('pricing')
export class PricingController {
  constructor(private readonly pricingService: PricingService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista las tarifas (vigentes e historicas) con filtros y orden',
  })
  @ApiBadRequestResponse({
    description: 'Filtro, columna de orden o rango de fechas no validos',
  })
  public async findPage(
    @Query() query: ListPricingQueryDto,
  ): Promise<PricingPageResponseDto> {
    return this.pricingService.findPage(query);
  }

  @Post()
  @AuditAction({
    table: AuditTable.PRECIOS_MODELOS_IA,
    action: AuditActionType.CREATE,
  })
  @ApiOperation({
    summary:
      'Registra la tarifa vigente de un modelo; la anterior pasa a historico',
  })
  @ApiConflictResponse({
    description:
      'Tarifa identica a la vigente, o alta concurrente del mismo par',
  })
  public async create(
    @Body() createPricingDto: CreatePricingDto,
    @CurrentUser() currentUser: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<PricingResponseDto> {
    return this.pricingService.create(
      createPricingDto,
      currentUser.id,
      extractClientIp(request),
    );
  }
}
