import { Exclude } from 'class-transformer';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { UserRole } from '../enums/user-role.enum';

@Entity('usuarios')
export class User {
  @PrimaryGeneratedColumn('uuid', { name: 'id_usuario' })
  id: string;

  @Column({ name: 'correo', type: 'varchar', length: 255, unique: true })
  email: string;

  @Column({
    name: 'rol',
    type: 'enum',
    enum: UserRole,
    enumName: 'enum_rol_usuario',
  })
  role: UserRole;

  /**
   * Secreto TOTP de la cuenta (base32). Doble barrera para que no se filtre:
   *
   * - `select: false` lo excluye de todo `find`, asi que ni siquiera se carga en
   *   memoria salvo peticion explicita con `addSelect`.
   * - `@Exclude()` lo borra de la serializacion cuando SI se ha cargado, que es
   *   el caso del flujo de autenticacion.
   *
   * Es `nullable` porque la inscripcion es perezosa: se genera la primera vez
   * que el usuario solicita un codigo.
   */
  @Exclude()
  @Column({
    name: 'secreto_otp',
    type: 'varchar',
    length: 64,
    nullable: true,
    select: false,
  })
  otpSecret: string | null;

  // Borrado lógico: nunca se elimina el registro físicamente
  @Column({ name: 'activo', type: 'boolean', default: true })
  isActive: boolean;
}
