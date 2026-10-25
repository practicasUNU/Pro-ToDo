import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  Get,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOperation,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { AuditTable } from '@modules/audit/audit-tables';
import { AuditAction } from '@modules/audit/decorators/audit-action.decorator';
import { AuditActionType } from '@modules/audit/enums/audit-action.enum';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { UserRole } from '@modules/users/enums/user-role.enum';

import { CredentialsService } from './credentials.service';
import { CreateCredentialDto } from './dto/create-credential.dto';
import {
  CredentialOptionDto,
  CredentialResponseDto,
} from './dto/credential-response.dto';
import { UpdateCredentialDto } from './dto/update-credential.dto';
import { CredentialAuthType } from './enums/credential-auth-type.enum';

/**
 * Boveda de credenciales cifradas de los nodos de destino.
 *
 * El CRUD es EXCLUSIVO del ADMIN, declarado a nivel de clase para que ningun
 * endpoint futuro quede abierto por olvido (Poka-Yoke). La unica excepcion es
 * `GET /credentials/options`, que reabre a EDITOR solo los METADATOS que
 * necesita el selector cerrado del nodo DESTINO_HTTP_GENERICO: id, nombre y
 * tipo. `RolesGuard` usa `getAllAndOverride`, asi que el `@Roles` del metodo
 * sustituye al de la clase.
 *
 * Ninguna respuesta lleva el secreto: el alta y la edicion lo reciben, pero lo
 * que devuelven es `CredentialResponseDto`, una lista blanca sin el.
 */
@ApiTags('credentials')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, expirado o invalido' })
@ApiForbiddenResponse({
  description: 'IP fuera de la red corporativa o rol distinto de ADMIN',
})
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(ClassSerializerInterceptor)
@Roles(UserRole.ADMIN)
@Controller('credentials')
export class CredentialsController {
  constructor(private readonly credentialsService: CredentialsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista las credenciales (sin secretos)' })
  public async findAll(): Promise<CredentialResponseDto[]> {
    const credentials = await this.credentialsService.findAll();

    return credentials.map((credential) =>
      plainToInstance(CredentialResponseDto, credential),
    );
  }

  /** Declarada ANTES de `:id`: si no, Nest leeria "options" como un id. */
  @Get('options')
  @Roles(UserRole.ADMIN, UserRole.EDITOR)
  @ApiOperation({
    summary:
      'Opciones del selector de credencial del nodo DESTINO_HTTP_GENERICO',
  })
  @ApiQuery({ name: 'authType', required: false, enum: CredentialAuthType })
  public async findOptions(
    @Query(
      'authType',
      new ParseEnumPipe(CredentialAuthType, { optional: true }),
    )
    authType?: CredentialAuthType,
  ): Promise<CredentialOptionDto[]> {
    const credentials = await this.credentialsService.findOptions(authType);

    return credentials.map((credential) =>
      plainToInstance(CredentialOptionDto, credential),
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtiene los metadatos de una credencial' })
  public async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CredentialResponseDto> {
    return plainToInstance(
      CredentialResponseDto,
      await this.credentialsService.findOne(id),
    );
  }

  @Post()
  @AuditAction({
    table: AuditTable.CREDENTIALS,
    action: AuditActionType.CREATE,
  })
  @ApiOperation({ summary: 'Da de alta una credencial cifrada' })
  @ApiConflictResponse({
    description: 'Ya existe una credencial con ese nombre',
  })
  @ApiServiceUnavailableResponse({
    description: 'Falta CREDENTIALS_ENCRYPTION_KEY en el servidor',
  })
  public async create(
    @Body() createCredentialDto: CreateCredentialDto,
  ): Promise<CredentialResponseDto> {
    return plainToInstance(
      CredentialResponseDto,
      await this.credentialsService.create(createCredentialDto),
    );
  }

  @Patch(':id')
  @AuditAction({
    table: AuditTable.CREDENTIALS,
    action: AuditActionType.UPDATE,
  })
  @ApiOperation({
    summary:
      'Edita una credencial; el secreto solo se reemplaza si se envia completo',
  })
  @ApiConflictResponse({
    description: 'Nombre duplicado, o cambio de tipo de una credencial en uso',
  })
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateCredentialDto: UpdateCredentialDto,
  ): Promise<CredentialResponseDto> {
    return plainToInstance(
      CredentialResponseDto,
      await this.credentialsService.update(id, updateCredentialDto),
    );
  }

  @Delete(':id')
  @AuditAction({
    table: AuditTable.CREDENTIALS,
    action: AuditActionType.DELETE,
  })
  @ApiOperation({ summary: 'Borra una credencial que ningun flujo usa' })
  @ApiConflictResponse({
    description: 'La credencial esta citada por un flujo o plantilla de flujo',
  })
  public async remove(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CredentialResponseDto> {
    return plainToInstance(
      CredentialResponseDto,
      await this.credentialsService.remove(id),
    );
  }
}
