import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';

import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  public findAll(): Promise<User[]> {
    return this.usersService.findAll();
  }

  @Get(':id')
  public findOne(@Param('id') id: string): Promise<User> {
    return this.usersService.findOne(id);
  }

  @Post()
  public create(@Body() createUserDto: CreateUserDto): Promise<User> {
    return this.usersService.create(createUserDto);
  }

  @Patch(':id')
  public update(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto): Promise<User> {
    return this.usersService.update(id, updateUserDto);
  }

  // Borrado lógico: nunca elimina físicamente el registro
  @Delete(':id')
  public remove(@Param('id') id: string): Promise<User> {
    return this.usersService.remove(id);
  }
}
