import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { NodeCategory } from '../enums/node-category.enum';

/**
 * Entrada del catalogo de tipos de nodo (tabla `nodos`).
 *
 * NO es una tabla de instancias: la secuencia de pasos de cada flujo vive
 * integra en `flujos.configuracion_pipeline` como JSONB. Esta tabla responde a
 * "que sabe ejecutar el motor", y por eso es de solo lectura desde la API: sus
 * filas las siembra `init.sql` y las alinea `db/migrations/005-tipos-nodo-fsm.sql`.
 * Hasta la migracion 011 se llamaba `tipos_nodo`.
 *
 * Propiedades en ingles y columnas en espanol, igual que `WorkflowTemplate`,
 * `HtmlTemplate` y `User`. Los tipos y longitudes replican `init.sql`: con
 * `synchronize: false` TypeORM no altera el esquema, asi que una discrepancia
 * aqui no se corregiria sola.
 */
@Entity('nodos')
export class NodeCatalogEntry {
  @PrimaryGeneratedColumn('uuid', { name: 'id_nodo' })
  id: string;

  /**
   * Codigo estable del tipo, replicado por el enum `NodeType`.
   *
   * Es la clave real del catalogo para todo lo que no sea SQL: el
   * `pipeline_schema` referencia tipos por este codigo, nunca por el UUID.
   */
  @Column({ name: 'codigo', type: 'varchar', length: 50, unique: true })
  code: string;

  @Column({ name: 'nombre', type: 'varchar', length: 100 })
  name: string;

  /** Familia funcional; agrupa el catalogo en el selector del ensamblador. */
  @Column({
    name: 'categoria',
    type: 'enum',
    enum: NodeCategory,
    enumName: 'enum_categoria',
  })
  category: NodeCategory;

  @Column({ name: 'descripcion', type: 'varchar', length: 255, nullable: true })
  description: string | null;

  // NO hay propiedad para el formulario del frontend. La columna `ui_schema`
  // se retiro en la migracion 020: el formulario de cada tipo lo resuelve el
  // frontend con componentes tipados via `node-config-registry.ts`, y el
  // contrato de SALIDA del nodo vive en los `outputFields` de su
  // `INodeStrategy`. Un descriptor jsonb paralelo era una segunda definicion
  // del mismo formulario, destinada a desincronizarse de la primera.
}
