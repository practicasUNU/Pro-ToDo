import { Exclude } from 'class-transformer';
import { Column, Entity, PrimaryColumn } from 'typeorm';

import { AuditableEntity } from '@common/entities/auditable.entity';

import { CredentialAuthType } from '../enums/credential-auth-type.enum';

/**
 * Boveda de credenciales cifradas (migracion 055).
 *
 * `PrimaryColumn` y no `PrimaryGeneratedColumn`: el identificador se genera en
 * la aplicacion ANTES del INSERT porque es el dato asociado (AAD) del cifrado.
 * Generado por PostgreSQL no se conoceria al cifrar.
 *
 * Las tres columnas criptograficas llevan `select: false` y `@Exclude()`: no se
 * cargan en ninguna consulta por defecto —tampoco en la fotografia de
 * auditoria— y, si alguien las cargara, no saldrian en una respuesta. Solo
 * `CredentialsService.resolveSecret` las pide, con `addSelect` explicito.
 *
 * Hereda `AuditableEntity` desde la migracion 058 (`creado_por`,
 * `fecha_creacion`, `actualizado_por`, `fecha_actualizacion`), como el resto de
 * tablas maestras: la tabla de Credenciales muestra quien roto por ultima vez
 * cada secreto sin consultar `audit_eventos`.
 */
@Entity('credenciales')
export class Credential extends AuditableEntity {
  @PrimaryColumn('uuid', { name: 'id_credencial' })
  id: string;

  @Column({ name: 'nombre', type: 'varchar', length: 100, unique: true })
  name: string;

  @Column({ name: 'tipo_autenticacion', type: 'varchar', length: 20 })
  authType: CredentialAuthType;

  @Exclude()
  @Column({ name: 'datos_cifrados', type: 'text', select: false })
  encryptedData: string;

  @Exclude()
  @Column({ name: 'vector_inicializacion', type: 'text', select: false })
  iv: string;

  @Exclude()
  @Column({ name: 'etiqueta_autenticacion', type: 'text', select: false })
  authTag: string;
}
