import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('allowed_ips')
export class AllowedIp {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string;

  @Column({ name: 'ip_o_cidr', type: 'varchar', length: 64, unique: true })
  ipOrCidr: string;

  @Column({ name: 'descripcion', type: 'varchar', length: 255 })
  description: string;

  @CreateDateColumn({ name: 'creado_en', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'actualizado_en', type: 'timestamptz' })
  updatedAt: Date;
}
