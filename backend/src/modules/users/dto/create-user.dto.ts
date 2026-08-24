import { IsBoolean, IsEmail, IsEnum, IsOptional, MaxLength } from 'class-validator';

import { UserRole } from '../enums/user-role.enum';

export class CreateUserDto {
  @IsEmail()
  @MaxLength(255)
  email: string;

  @IsEnum(UserRole)
  role: UserRole;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
