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

import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';
import { UserRole } from './enums/user-role.enum';
import { UsersService } from './users.service';

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
  description: 'IP fuera de la red corporativa o rol distinto de ADMIN',
})
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'Lista todos los usuarios' })
  public findAll(): Promise<User[]> {
    return this.usersService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtiene un usuario por su identificador' })
  public findOne(@Param('id', ParseUUIDPipe) id: string): Promise<User> {
    return this.usersService.findOne(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Crea un usuario con correo de dominio corporativo',
  })
  public create(@Body() createUserDto: CreateUserDto): Promise<User> {
    return this.usersService.create(createUserDto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualiza los datos de un usuario' })
  public update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateUserDto: UpdateUserDto,
  ): Promise<User> {
    return this.usersService.update(id, updateUserDto);
  }

  // Borrado logico: nunca elimina fisicamente el registro
  @Delete(':id')
  @ApiOperation({ summary: 'Desactiva un usuario (borrado logico)' })
  public remove(@Param('id', ParseUUIDPipe) id: string): Promise<User> {
    return this.usersService.remove(id);
  }
}
