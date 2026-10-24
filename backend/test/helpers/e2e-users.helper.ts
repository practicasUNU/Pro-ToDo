import { generateDevJwt } from '@common/utils/dev-jwt.util';
import { UserRole } from '@modules/users/enums/user-role.enum';

import type { JwtService } from '@nestjs/jwt';
import type { DataSource } from 'typeorm';

/**
 * Identidades de las suites e2e.
 *
 * POR QUE EXISTE. Desde la migracion 051, `JwtStrategy` consulta `usuarios` en
 * cada peticion: un token firmado para un id inventado —lo que hacian las
 * suites hasta entonces— recibe un 401 antes de llegar a ningun guard de rol.
 * Las pruebas que necesitan un EDITOR (para comprobar el 403) tienen que
 * sembrar una cuenta REAL.
 *
 * UUID v4 fijos y correos `@e2e.unuware.test` (dominio reservado, RFC 2606):
 * reconocibles a simple vista y sin colision posible con una cuenta real.
 */
export interface E2eUser {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
}

/**
 * Un EDITOR propio por suite.
 *
 * NO uno compartido: Jest ejecuta las suites e2e en PARALELO, y si dos
 * sembraran y borraran la misma fila, el `afterAll` de la primera en terminar
 * dejaria a la otra con tokens de una cuenta inexistente (401 intermitentes).
 * Cada suite pide su propio `slot` (1-255) y nadie pisa a nadie.
 */
export const e2eEditor = (slot: number, label: string): E2eUser => ({
  id: `00000000-0000-4000-8000-000000000${slot.toString(16).padStart(3, '0')}`,
  email: `${label}@e2e.unuware.test`,
  role: UserRole.EDITOR,
});

/** Slots reservados, uno por suite: anadir aqui antes de usar uno nuevo. */
export const E2E_SLOTS = {
  AUDIT: 1,
  TELEMETRY: 2,
  RESUME: 3,
  CANVAS: 4,
  RESILIENCE_EDITOR: 5,
  RESILIENCE_REVOKED: 6,
} as const;

/**
 * Inserta la cuenta o la RESTAURA (activa, rol original, generacion 0).
 * Idempotente: una suite abortada a medias no deja la siguiente en rojo.
 */
export const ensureE2eUser = async (
  dataSource: DataSource,
  user: E2eUser,
): Promise<void> => {
  await dataSource.query(
    `INSERT INTO usuarios (id_usuario, correo, rol, activo, token_version)
     VALUES ($1, $2, $3, TRUE, 0)
     ON CONFLICT (id_usuario)
     DO UPDATE SET correo = EXCLUDED.correo, rol = EXCLUDED.rol,
                   activo = TRUE, token_version = 0`,
    [user.id, user.email, user.role],
  );
};

/** Borra las cuentas sembradas. Sus autorias pasan a NULL por `ON DELETE SET NULL`. */
export const removeE2eUsers = async (
  dataSource: DataSource,
  users: readonly E2eUser[],
): Promise<void> => {
  await dataSource.query(`DELETE FROM usuarios WHERE id_usuario = ANY($1)`, [
    users.map((user) => user.id),
  ]);
};

/** El primer ADMIN activo de la base de pruebas, o un error que dice como crearlo. */
export const findActiveAdmin = async (
  dataSource: DataSource,
): Promise<E2eUser> => {
  const admins = await dataSource.query<
    Array<{ id_usuario: string; correo: string }>
  >(
    `SELECT id_usuario, correo FROM usuarios
      WHERE rol = 'ADMIN' AND activo = TRUE
      ORDER BY fecha_creacion LIMIT 1`,
  );

  if (admins.length === 0) {
    throw new Error(
      'No hay ningun usuario ADMIN activo en la base de pruebas: ejecuta `npm run test:bootstrap`.',
    );
  }

  return {
    id: admins[0].id_usuario,
    email: admins[0].correo,
    role: UserRole.ADMIN,
  };
};

/**
 * Token para una cuenta real, con la generacion que tenga AHORA en la base.
 * Leerla en vez de suponer 0 evita falsos 401 si otra suite la subio.
 */
export const signFor = async (
  jwtService: JwtService,
  dataSource: DataSource,
  user: E2eUser,
): Promise<string> => {
  const [row] = await dataSource.query<Array<{ token_version: number }>>(
    `SELECT token_version FROM usuarios WHERE id_usuario = $1`,
    [user.id],
  );

  return generateDevJwt(jwtService, {
    userId: user.id,
    email: user.email,
    role: user.role,
    tokenVersion: row?.token_version ?? 0,
  });
};
