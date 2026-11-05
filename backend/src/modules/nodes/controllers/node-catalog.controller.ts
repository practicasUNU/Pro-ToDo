import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { NodeCatalogResponseDto } from '@modules/nodes/dto/node-catalog-response.dto';
import { NodeCatalogService } from '@modules/nodes/services/node-catalog.service';
import { UserRole } from '@modules/users/enums/user-role.enum';

/**
 * Catalogo de tipos de nodo (`GET /api/nodos`).
 *
 * Mismo perimetro que `TemplatesController`: ADMIN y EDITOR. Un EDITOR necesita
 * el catalogo para ensamblar la topologia de una plantilla, y la escritura no
 * existe en ninguna ruta, asi que no hay nada que restringir a ADMIN.
 *
 * La ruta va en espanol (`nodos`) por coherencia con `/api/flujos` del frontend
 * y con el nombre de la tabla; los identificadores del codigo siguen en ingles.
 */
@ApiTags('nodos')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, expirado o invalido' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.EDITOR)
@Controller('nodos')
export class NodeCatalogController {
  constructor(private readonly nodeCatalogService: NodeCatalogService) {}

  @Get()
  @ApiOperation({
    summary:
      'Lista los tipos de nodo que el motor conoce, agrupables por categoria',
  })
  @ApiOkResponse({
    description:
      'Catalogo completo. Los tipos sin estrategia llegan con `implemented: false`',
    type: [NodeCatalogResponseDto],
  })
  public async findAll(): Promise<NodeCatalogResponseDto[]> {
    return this.nodeCatalogService.findAll();
  }
}
