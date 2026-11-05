import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { AuditableEntity } from '@common/entities/auditable.entity';

/**
 * `creado_en` / `actualizado_en` pasaron a `fecha_creacion` /
 * `fecha_actualizacion` en la migracion 045, que es lo que hereda de
 * `AuditableEntity`.
 */
@Entity('allowed_ips')
export class AllowedIp extends AuditableEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string;

  @Column({ name: 'ip_o_cidr', type: 'varchar', length: 64, unique: true })
  ipOrCidr: string;

  @Column({ name: 'descripcion', type: 'varchar', length: 255 })
  description: string;
}
