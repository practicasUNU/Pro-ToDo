import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { UserRole } from '../enums/user-role.enum';

@Entity('usuarios')
export class User {
  @PrimaryGeneratedColumn('uuid', { name: 'id_usuario' })
  id: string;

  @Column({ name: 'correo', type: 'varchar', length: 255, unique: true })
  email: string;

  @Column({ name: 'rol', type: 'enum', enum: UserRole, enumName: 'enum_rol_usuario' })
  role: UserRole;

  // Borrado lógico: nunca se elimina el registro físicamente
  @Column({ name: 'activo', type: 'boolean', default: true })
  isActive: boolean;
}
