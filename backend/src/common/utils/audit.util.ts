import type { AuditableEntity } from '@common/entities/auditable.entity';
import type {
  AuditFieldsResponseDto,
  AuditUserResponseDto,
} from '@common/dto/audit-response.dto';
import type { User } from '@modules/users/entities/user.entity';

/**
 * Relaciones que hay que cargar para poder proyectar la auditoria. Se pasa tal
 * cual a `find({ relations })`.
 */
export const AUDIT_RELATIONS = { createdBy: true, updatedBy: true } as const;

/** Autor proyectado a `{ id, email }`, o `null` si no consta. */
export const toAuditUser = (
  user: Pick<User, 'id' | 'email'> | null | undefined,
): AuditUserResponseDto | null =>
  user ? { id: user.id, email: user.email } : null;

/**
 * Los cuatro campos de auditoria listos para la respuesta.
 *
 * Requiere la entidad cargada con `AUDIT_RELATIONS`; sin ellas los autores
 * salen `null`, nunca la entidad `User` entera.
 */
export const toAuditFields = (
  entity: AuditableEntity,
): AuditFieldsResponseDto => ({
  createdAt: entity.createdAt,
  updatedAt: entity.updatedAt,
  createdBy: toAuditUser(entity.createdBy),
  updatedBy: toAuditUser(entity.updatedBy),
});

/** Sella el alta: quien crea es tambien el ultimo en modificar. */
export const stampCreated = <T extends AuditableEntity>(
  entity: T,
  actorId: string,
): T => {
  entity.createdByUserId = actorId;
  entity.updatedByUserId = actorId;

  return entity;
};

/**
 * Sella una modificacion.
 *
 * Vacia la relacion `updatedBy` ademas de fijar la columna: cuando una entidad
 * se cargo con `AUDIT_RELATIONS`, TypeORM persiste el valor de la RELACION por
 * encima del de la columna FK, y el autor anterior pisaria al nuevo en silencio.
 * Con la relacion en `undefined` TypeORM la ignora y escribe la columna.
 */
export const stampUpdated = <T extends AuditableEntity>(
  entity: T,
  actorId: string,
): T => {
  entity.updatedByUserId = actorId;
  entity.updatedBy = undefined;

  return entity;
};
