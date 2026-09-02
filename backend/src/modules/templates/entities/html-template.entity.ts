import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Plantilla HTML reutilizable entre flujos (PROT-11.1).
 *
 * Sustituye al HTML incrustado en `params.template` del `pipeline_schema`: un
 * nodo `MAPEADOR_PLANTILLA` solo declara `templateId`, de modo que cambiar una
 * etiqueta no obliga a editar el JSON de cada flujo que la use.
 */
@Entity('plantillas_html')
export class HtmlTemplate {
  @PrimaryGeneratedColumn('uuid', { name: 'id_plantilla' })
  id: string;

  @Column({ name: 'nombre', type: 'varchar', length: 120, unique: true })
  name: string;

  @Column({
    name: 'descripcion',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  description: string | null;

  @Column({ name: 'contenido_html', type: 'text' })
  htmlContent: string;

  /**
   * Rutas `namespace.campo` detectadas en `htmlContent`, ya validadas contra la
   * lista blanca de namespaces.
   *
   * Es un campo DERIVADO: nunca llega por el DTO, lo recalcula
   * `TemplatesService` en cada escritura. Alimentara el `<q-select>` cerrado de
   * la Vista 4, que no admite variables escritas a mano.
   */
  @Column({ name: 'variables_esperadas', type: 'jsonb', default: () => "'[]'" })
  requiredVariables: string[];

  /**
   * Autor de la plantilla, tomado del JWT y no del cuerpo de la peticion: el
   * cliente no puede falsificar la autoria.
   */
  @Column({ name: 'id_usuario_creador', type: 'uuid' })
  createdById: string;

  // Borrado logico: nunca se elimina el registro fisicamente, para preservar la
  // trazabilidad de las ejecuciones que ya usaron esta plantilla.
  @Column({ name: 'activo', type: 'boolean', default: true })
  active: boolean;

  @CreateDateColumn({ name: 'fecha_creacion', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'fecha_actualizacion', type: 'timestamptz' })
  updatedAt: Date;
}
