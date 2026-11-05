import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { AuditableEntity } from '@common/entities/auditable.entity';
import { User } from '@modules/users/entities/user.entity';

/**
 * Plantilla de prompt reutilizable para el nodo `PROCESADOR_IA` (PROT-15.2).
 *
 * Se llama PLANTILLA y no prompt a secas porque lo que se guarda lleva
 * marcadores `{{nodo.campo}}` sin resolver; el prompt real es lo que sale de
 * interpolarla contra el `StatePayloadContext` de una ejecucion concreta.
 *
 * Sustituye a la instruccion incrustada en los `params` del nodo: dos flujos que
 * comparten la misma instruccion la duplicaban, y corregirla obligaba a editar
 * el `pipeline_schema` de cada uno. Es el mismo movimiento que hizo
 * `HtmlTemplate` con el HTML del mapeador.
 *
 * DESACOPLAMIENTO ESTRICTO: aqui no hay `provider`, `model`, `temperature` ni
 * `maxTokens`. Un prompt es un activo de TEXTO; que modelo lo ejecuta lo decide
 * la configuracion del nodo, y el contexto lo aporta el `StatePayloadContext` en
 * ejecucion. Guardar el modelo aqui ataria el texto a un proveedor y haria
 * imposible reutilizar el mismo prompt con Claude y con ChatGPT, que es
 * justamente el motivo de extraerlo.
 *
 * Propiedades en ingles y columnas en espanol, como el resto de entidades. Los
 * tipos y longitudes replican `init.sql` a proposito: con `synchronize: false`
 * TypeORM no altera el esquema, asi que una discrepancia aqui no se corregiria
 * sola, se convertiria en una mentira en el codigo.
 */
@Entity('plantillas_prompts_ia')
export class AiPromptTemplate extends AuditableEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id_plantilla_prompt_ia' })
  id: string;

  /**
   * Clave de MAQUINA del prompt (migracion 023).
   *
   * Es la unica referencia estable: el UUID se regenera en cada clonado de la
   * base y `name` es texto que el operador edita desde la tabla administrativa.
   * Un `pipeline_schema` versionado, una semilla o un test solo pueden citar un
   * prompt por aqui. Lo consume `promptCode` en los `params` del nodo
   * `PROCESADOR_IA`, que lo resuelve con `findByCode()`.
   *
   * INMUTABLE por contrato: el servicio descarta cualquier intento de
   * cambiarlo en una edicion. Renombrar la etiqueta visible es legitimo;
   * cambiar la clave romperia en silencio todos los flujos que la citan.
   */
  @Column({ name: 'codigo', type: 'varchar', length: 50, unique: true })
  code: string;

  /**
   * Etiqueta HUMANA del prompt.
   *
   * UNIQUE: es lo que el operador reconoce en el selector del nodo IA, y la
   * clave por la que lo resuelve `AiPromptTemplatesService.findByName()`.
   */
  @Column({ name: 'nombre', type: 'varchar', length: 120, unique: true })
  name: string;

  @Column({
    name: 'descripcion',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  description: string | null;

  /**
   * La instruccion en si: texto puro o plantilla con marcadores
   * `{{nodo.campo}}` que el motor resuelve contra los namespaces del contexto.
   */
  @Column({ name: 'texto_prompt', type: 'text' })
  promptText: string;

  // Borrado logico: un prompt retirado desaparece del selector, pero la fila
  // sigue explicando la salida de las ejecuciones que lo usaron.
  @Column({ name: 'activo', type: 'boolean', default: true })
  active: boolean;

  /**
   * Autor del prompt, tomado del JWT y no del cuerpo de la peticion: el cliente
   * no puede falsificar la autoria.
   */
  @Column({ name: 'id_usuario_creador', type: 'uuid' })
  createdById: string;

  /**
   * Relacion hacia el autor, con la columna FK declarada aparte (patron de
   * `RefreshToken`). NO se carga por defecto y nunca debe salir en una
   * respuesta: `User` lleva `secreto_otp` dentro. Por eso el servicio devuelve
   * DTOs y no la entidad.
   *
   * `RESTRICT` y no `CASCADE`: los prompts son patrimonio del equipo, y dar de
   * baja a una persona no puede llevarse por delante las instrucciones que dejo
   * en produccion.
   *
   * Se llama `creatorUser` y no `createdBy` porque ese nombre lo ocupa la
   * relacion de `AuditableEntity` sobre `creado_por` (migracion 045).
   */
  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'id_usuario_creador' })
  creatorUser: User;
}
