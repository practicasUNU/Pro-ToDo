import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { AuditActionType } from '@modules/audit/enums/audit-action.enum';

import type { User } from '@modules/users/entities/user.entity';

/**
 * Evento de auditoria de una accion humana (migracion 048).
 *
 * Registro INMUTABLE de solo insercion, como `telemetria_tokens_ia`: no hereda
 * `AuditableEntity` porque nadie lo modifica despues. Complementa —no
 * sustituye— a `creado_por` / `actualizado_por` de las maestras, que solo
 * guardan el ultimo cambio.
 */
@Entity('audit_eventos')
export class AuditEvento {
  @PrimaryGeneratedColumn('uuid', { name: 'id_audit_evento' })
  id: string;

  /** Quien actuo. `null` en un login fallido de un correo que no existe. */
  @Column({ name: 'usuario_id', type: 'uuid', nullable: true })
  userId: string | null;

  /**
   * Relacion por cadena (`'User'`) como en `AuditableEntity`: importar la
   * entidad abriria un ciclo de modulos `users` <-> `audit`.
   */
  @ManyToOne('User', { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'usuario_id' })
  user?: User | null;

  @Column({ name: 'accion', type: 'varchar', length: 30 })
  action: AuditActionType;

  @Column({ name: 'tabla_afectada', type: 'varchar', length: 60 })
  affectedTable: string;

  @Column({ name: 'registro_id', type: 'varchar', length: 64, nullable: true })
  recordId: string | null;

  @Column({ name: 'datos_anteriores', type: 'jsonb', nullable: true })
  previousData: Record<string, unknown> | null;

  @Column({ name: 'datos_nuevos', type: 'jsonb', nullable: true })
  newData: Record<string, unknown> | null;

  @Column({ name: 'ip_origen', type: 'varchar', length: 45, nullable: true })
  sourceIp: string | null;

  @CreateDateColumn({ name: 'creado_en', type: 'timestamptz' })
  createdAt: Date;
}
