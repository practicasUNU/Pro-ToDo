import { ApiProperty } from '@nestjs/swagger';
import { Exclude, Expose } from 'class-transformer';

import { UserRole } from '../enums/user-role.enum';

/**
 * Representacion publica de un usuario.
 *
 * `@Exclude()` a nivel de clase invierte la politica de serializacion: nada sale
 * salvo lo marcado con `@Expose()`. Es la version segura por defecto — un campo
 * nuevo en la entidad no aparece en la respuesta hasta que alguien lo exponga
 * de forma deliberada, en lugar de filtrarse por olvido.
 */
@Exclude()
export class UserResponseDto {
  @Expose()
  @ApiProperty({ format: 'uuid' })
  id: string;

  @Expose()
  @ApiProperty({ example: 'usuario@unuware.com' })
  email: string;

  @Expose()
  @ApiProperty({ enum: UserRole })
  role: UserRole;

  @Expose()
  @ApiProperty({ description: 'Falso tras un borrado logico' })
  isActive: boolean;

  // `otpSecret` no lleva @Expose(): queda fuera de la respuesta por omision.
}
