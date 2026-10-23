import {
  AUDIT_RELATIONS,
  stampCreated,
  stampUpdated,
  toAuditFields,
  toAuditUser,
} from '@common/utils/audit.util';

import type { AuditableEntity } from '@common/entities/auditable.entity';
import type { User } from '@modules/users/entities/user.entity';

const ACTOR_ID = '3f1c2b64-8a5e-4c2f-9d3a-7b6e5f4c1a20';
const PREVIOUS_ID = 'b27d9e10-4c3f-4a8b-9f21-6d5e4c3b2a19';
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const UPDATED_AT = new Date('2026-02-01T00:00:00.000Z');

/** Usuario con TODO cargado, secreto incluido: lo que nunca debe salir. */
const buildUser = (id: string, email: string): User =>
  ({
    id,
    email,
    otpSecret: 'JBSWY3DPEHPK3PXP',
    isActive: true,
  }) as User;

const buildEntity = (
  overrides: Partial<AuditableEntity> = {},
): AuditableEntity => ({
  createdByUserId: null,
  updatedByUserId: null,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  ...overrides,
});

describe('audit.util', () => {
  it('AUDIT_RELATIONS deberia pedir las dos relaciones de autoria', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(AUDIT_RELATIONS).toEqual({ createdBy: true, updatedBy: true });
  });

  it('toAuditUser deberia reducir el usuario a id y correo', () => {
    // 1. Arrange 📐
    const user = buildUser(ACTOR_ID, 'admin@unuware.com');

    // 2. Act ⚙️
    const projected = toAuditUser(user);

    // 3. Assert 🎯: ni el secreto ni el estado viajan.
    expect(projected).toEqual({ id: ACTOR_ID, email: 'admin@unuware.com' });
  });

  it('toAuditUser deberia devolver null cuando no consta autor', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(toAuditUser(null)).toBeNull();
    expect(toAuditUser(undefined)).toBeNull();
  });

  it('toAuditFields deberia proyectar fechas y autores', () => {
    // 1. Arrange 📐
    const entity = buildEntity({
      createdBy: buildUser(ACTOR_ID, 'admin@unuware.com'),
      updatedBy: null,
    });

    // 2. Act ⚙️
    const fields = toAuditFields(entity);

    // 3. Assert 🎯
    expect(fields).toEqual({
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      createdBy: { id: ACTOR_ID, email: 'admin@unuware.com' },
      updatedBy: null,
    });
  });

  it('stampCreated deberia firmar el alta en las dos columnas', () => {
    // 1. Arrange 📐
    const entity = buildEntity();

    // 2. Act ⚙️
    stampCreated(entity, ACTOR_ID);

    // 3. Assert 🎯: quien crea es tambien el ultimo en modificar.
    expect(entity.createdByUserId).toBe(ACTOR_ID);
    expect(entity.updatedByUserId).toBe(ACTOR_ID);
  });

  it('stampUpdated deberia vaciar la relacion para que gane la columna', () => {
    // 1. Arrange 📐: entidad cargada con AUDIT_RELATIONS, con otro autor previo.
    //    Si la relacion siguiera ahi, TypeORM persistiria el autor anterior.
    const entity = buildEntity({
      createdByUserId: PREVIOUS_ID,
      updatedByUserId: PREVIOUS_ID,
      updatedBy: buildUser(PREVIOUS_ID, 'editor@unuware.com'),
    });

    // 2. Act ⚙️
    stampUpdated(entity, ACTOR_ID);

    // 3. Assert 🎯: el alta original no se toca.
    expect(entity.updatedByUserId).toBe(ACTOR_ID);
    expect(entity.updatedBy).toBeUndefined();
    expect(entity.createdByUserId).toBe(PREVIOUS_ID);
  });
});
