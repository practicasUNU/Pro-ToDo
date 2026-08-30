import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
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
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';

import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { UserRole } from './enums/user-role.enum';
import { UsersService } from './users.service';

import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';
import type { User } from './entities/user.entity';

/**
 * CRUD de usuarios (CU-02), reservado en exclusiva al rol ADMIN (PROT-04.2).
 *
 * Los guards se declaran a nivel de clase para que ningun endpoint futuro pueda
 * quedar desprotegido por olvido (Poka-Yoke). Un EDITOR autenticado recibe 403 en
 * cualquiera de estas rutas.
 */
@ApiTags('users')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, expirado o invalido' })
@ApiForbiddenResponse({
  description:
    'IP fuera de la red corporativa, rol distinto de ADMIN, o intento de modificar/eliminar la propia cuenta',
})
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(ClassSerializerInterceptor)
@Roles(UserRole.ADMIN)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * Proyecta la entidad al DTO publico. `UserResponseDto` lleva `@Exclude()` de
   * clase, asi que solo sobreviven los campos con `@Expose()`: un campo nuevo en
   * la entidad no se filtra hasta que alguien lo exponga a proposito.
   */
  private toResponse(user: User): UserResponseDto {
    return plainToInstance(UserResponseDto, user);
  }

  @Get()
  @ApiOperation({ summary: 'Lista todos los usuarios' })
  public async findAll(): Promise<UserResponseDto[]> {
    const users = await this.usersService.findAll();
    return users.map((user) => this.toResponse(user));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtiene un usuario por su identificador' })
  public async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UserResponseDto> {
    return this.toResponse(await this.usersService.findOne(id));
  }

  @Post()
  @ApiOperation({
    summary: 'Crea un usuario con correo de dominio corporativo',
  })
  public async create(
    @Body() createUserDto: CreateUserDto,
  ): Promise<UserResponseDto> {
    return this.toResponse(await this.usersService.create(createUserDto));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualiza los datos de un usuario' })
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateUserDto: UpdateUserDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    this.assertNotOperatingOnSelf(currentUser, id);

    return this.toResponse(await this.usersService.update(id, updateUserDto));
  }

  // Borrado logico: nunca elimina fisicamente el registro
  @Delete(':id')
  @ApiOperation({ summary: 'Desactiva un usuario (borrado logico)' })
  public async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    this.assertNotOperatingOnSelf(currentUser, id);

    return this.toResponse(await this.usersService.remove(id));
  }

  /**
   * Bloquea la auto-modificacion y la auto-eliminacion (MOD-01).
   *
   * Un ADMIN que se desactiva o se degrada a si mismo puede quedar fuera del
   * unico modulo que gestiona cuentas, sin otro ADMIN activo que lo revierta.
   */
  private assertNotOperatingOnSelf(
    currentUser: AuthenticatedUser,
    targetId: string,
  ): void {
    if (currentUser.id === targetId) {
      throw new ForbiddenException(
        'Operación denegada: No puedes modificar ni eliminar tu propio usuario.',
      );
    }
  }
}
