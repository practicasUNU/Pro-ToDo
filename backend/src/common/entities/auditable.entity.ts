import {
  Column,
  CreateDateColumn,
  JoinColumn,
  ManyToOne,
  UpdateDateColumn,
} from 'typeorm';

import type { User } from '@modules/users/entities/user.entity';

/**
 * Columnas de auditoria comunes a las tablas maestras (migracion 045).
 *
 * Clase abstracta SIN `@Entity`: TypeORM hereda sus columnas en cada subclase,
 * de modo que `allowed_ips`, `plantillas_html`, `flujos`, `usuarios`,
 * `plantillas_flujo` y `plantillas_prompts_ia` comparten nombres y tipos
 * (`TIMESTAMPTZ` en todas, antes habia una mezcla con y sin zona horaria).
 *
 * La relacion hacia `User` se declara por NOMBRE (`'User'`) y con
 * `import type`, no con `() => User`: `User` tambien hereda de esta clase, y
 * una importacion de valor cerraria un ciclo en el que, segun el orden de
 * carga, `User extends undefined` reventaria al arrancar.
 *
 * `creado_por` / `actualizado_por` son nullable a proposito: las filas
 * historicas no tienen autor conocido y un usuario borrado no debe arrastrar
 * los registros que toco (`ON DELETE SET NULL`). NO sustituyen a
 * `id_usuario_creador` donde existe: esa columna sigue siendo el contrato de
 * los servicios actuales y la migracion 045 la copia aqui como semilla.
 *
 * Las relaciones no son `eager`: `User` lleva `secreto_otp`, y cargarlo por
 * defecto lo pondria a un `JSON.stringify` de distancia de una respuesta HTTP.
 */
export abstract class AuditableEntity {
  @Column({ name: 'creado_por', type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @ManyToOne('User', { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'creado_por' })
  createdBy?: User | null;

  @CreateDateColumn({ name: 'fecha_creacion', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'actualizado_por', type: 'uuid', nullable: true })
  updatedByUserId: string | null;

  @ManyToOne('User', { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'actualizado_por' })
  updatedBy?: User | null;

  @UpdateDateColumn({ name: 'fecha_actualizacion', type: 'timestamptz' })
  updatedAt: Date;
}
