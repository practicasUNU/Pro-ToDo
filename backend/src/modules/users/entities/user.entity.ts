import { Exclude } from 'class-transformer';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { AuditableEntity } from '@common/entities/auditable.entity';

import { UserRole } from '../enums/user-role.enum';

/**
 * Hereda la auditoria como el resto de tablas maestras: `creado_por` apunta a
 * la propia tabla `usuarios` (el ADMIN que dio de alta la cuenta).
 */
@Entity('usuarios')
export class User extends AuditableEntity {
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

  /**
   * Generación de los tokens válidos de esta cuenta (migración 051).
   *
   * El access token es autocontenido y la estrategia no podía desautorizarlo:
   * un rol revocado seguía vigente hasta que el JWT caducaba solo. El valor
   * viaja como claim y `JwtStrategy` lo compara contra esta columna, así que
   * incrementarlo invalida en el acto todas las sesiones vivas del usuario.
   *
   * Lo incrementa `UsersService` SOLO cuando cambia algo que altera los
   * privilegios o la identidad —rol, estado activo o correo—; una edición
   * indiferente no tiene por qué echar a nadie de su sesión.
   */
  @Column({ name: 'token_version', type: 'int', default: 0 })
  tokenVersion: number;
}
