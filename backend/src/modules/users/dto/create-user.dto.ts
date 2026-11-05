import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  MaxLength,
} from 'class-validator';

import { TrimmedString } from '@common/decorators/trimmed-string.decorator';

import { UserRole } from '../enums/user-role.enum';

export class CreateUserDto {
  @TrimmedString()
  @IsEmail()
  @MaxLength(255)
  email: string;

  @IsEnum(UserRole)
  role: UserRole;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
