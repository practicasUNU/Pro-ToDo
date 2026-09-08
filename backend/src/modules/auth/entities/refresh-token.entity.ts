import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from '@modules/users/entities/user.entity';

/**
 * Credencial de renovacion de sesion (PROT-06.4).
 *
 * A diferencia del access token, que es un JWT autocontenido y no revocable, el
 * refresh token es opaco y su validez la decide esta tabla. Eso es justo lo que
 * permite revocarlo antes de tiempo.
 *
 * En la columna solo vive el SHA-256 del valor: una lectura de la base de datos
 * no entrega credenciales reutilizables.
 *
 * La tabla es `tokens_sesion` y la clase `RefreshToken`: no es un renombrado a
 * medias sino la convencion del proyecto, la misma de `User`/`usuarios` y
 * `Workflow`/`flujos` — esquema en castellano, identificadores de codigo en
 * ingles (`code-conventions.md` §1), y el puente en `@Entity()` /
 * `@Column({ name })`. El nombre viejo de la tabla era `refresh_tokens`; lo
 * renombra la migracion 009, sin la cual el modulo no arranca.
 */
@Entity('tokens_sesion')
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid', { name: 'id_token_sesion' })
  id: string;

  @Index('idx_tokens_sesion_id_usuario')
  @Column({ name: 'id_usuario', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'id_usuario' })
  user: User;

  /**
   * Dispositivo/navegador que abrio la sesion. Lo genera y persiste el cliente.
   *
   * Agrupa los tokens por origen para que emitir uno nuevo revoque solo la sesion
   * anterior de ESE dispositivo. No es un dato de confianza: lo elige el cliente y
   * nunca se usa como entrada de autorizacion, solo acotado a `userId`.
   */
  @Column({ name: 'id_dispositivo', type: 'uuid' })
  deviceId: string;

  @Column({ name: 'hash_token', type: 'char', length: 64, unique: true })
  tokenHash: string;

  @Column({ name: 'expiracion', type: 'timestamp' })
  expiresAt: Date;

  /** Un token solo puede canjearse una vez; se marca en lugar de borrarse. */
  @Column({ name: 'revocado', type: 'boolean', default: false })
  isRevoked: boolean;

  @CreateDateColumn({ name: 'fecha_creacion', type: 'timestamp' })
  createdAt: Date;
}
