import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AuditTable } from '@modules/audit/audit-tables';
import { AiPromptTemplate } from '@modules/ai-prompt-templates/entities/ai-prompt-template.entity';
import { AllowedIp } from '@modules/security/allowed-ips/entities/allowed-ip.entity';
import { HtmlTemplate } from '@modules/templates/entities/html-template.entity';
import { User } from '@modules/users/entities/user.entity';
import { WorkflowTemplate } from '@modules/workflow-templates/entities/workflow-template.entity';
import { Workflow } from '@modules/workflows/entities/workflow.entity';

import type { EntityTarget, ObjectLiteral } from 'typeorm';

/** Fotografia plana de un registro, lista para `JSONB`. */
export type AuditSnapshot = Record<string, unknown>;

/**
 * Claves que NUNCA entran en una fotografia, aunque la entidad las traiga
 * cargadas: secretos TOTP, contrasenas y cualquier token. Se compara en
 * minusculas y por subcadena, para cubrir `otpSecret`, `secreto_otp`,
 * `refreshToken`, `apiToken`...
 */
const SENSITIVE_KEY_PATTERN = /secret|secreto|password|contrasena|token/i;

/**
 * Techo por cadena. Una plantilla HTML o un esquema de pipeline pueden pesar
 * cientos de KB; repetirlos enteros en cada evento haria crecer la tabla de
 * auditoria mas que la propia maestra. Se conserva el principio, con marca.
 */
export const MAX_SNAPSHOT_STRING = 10_000;

/** Entidad de cada tabla auditada. */
const ENTITY_BY_TABLE: Readonly<
  Record<AuditTable, EntityTarget<ObjectLiteral>>
> = {
  [AuditTable.USERS]: User,
  [AuditTable.WORKFLOWS]: Workflow,
  [AuditTable.HTML_TEMPLATES]: HtmlTemplate,
  [AuditTable.WORKFLOW_TEMPLATES]: WorkflowTemplate,
  [AuditTable.AI_PROMPT_TEMPLATES]: AiPromptTemplate,
  [AuditTable.ALLOWED_IPS]: AllowedIp,
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  Object.getPrototypeOf(value) === Object.prototype;

const sanitizeValue = (value: unknown): unknown => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'string' && value.length > MAX_SNAPSHOT_STRING) {
    return `${value.slice(0, MAX_SNAPSHOT_STRING)}… [recortado: ${value.length} caracteres]`;
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (isPlainObject(value)) {
    return sanitizeSnapshot(value);
  }

  return value;
};

/**
 * Deja solo datos planos y sin secretos.
 *
 * Fuera quedan las claves sensibles y las RELACIONES cargadas (instancias de
 * otra entidad, como `createdBy`): un `User` anidado arrastraria su rol, su
 * estado y, si alguien lo cargo con `addSelect`, su secreto. Los JSONB de la
 * propia fila (esquema del pipeline, variables) son objetos planos y se
 * conservan, saneados de forma recursiva.
 */
export const sanitizeSnapshot = (
  source: Record<string, unknown>,
): AuditSnapshot =>
  Object.entries(source).reduce<AuditSnapshot>((snapshot, [key, value]) => {
    if (SENSITIVE_KEY_PATTERN.test(key) || value === undefined) {
      return snapshot;
    }

    const isRelation =
      typeof value === 'object' &&
      value !== null &&
      !(value instanceof Date) &&
      !Array.isArray(value) &&
      !isPlainObject(value);

    return isRelation ? snapshot : { ...snapshot, [key]: sanitizeValue(value) };
  }, {});

/**
 * Lee la fotografia de un registro auditado para `datos_anteriores` y
 * `datos_nuevos`.
 *
 * Usa `DataSource.getRepository` y no los servicios de cada dominio: asi
 * `AuditModule` no importa ningun modulo de negocio (que a su vez necesitan el
 * decorador de auditoria) y no se cierra ningun ciclo. Lee la fila tal cual
 * esta en la base de datos, sin relaciones: la misma forma antes y despues del
 * cambio, que es lo que permite compararlas.
 */
@Injectable()
export class AuditSnapshotService {
  constructor(private readonly dataSource: DataSource) {}

  public async load(
    table: AuditTable,
    id: string,
  ): Promise<AuditSnapshot | null> {
    const entity = ENTITY_BY_TABLE[table];
    const row = await this.dataSource
      .getRepository(entity)
      .findOne({ where: { id } });

    return row === null ? null : sanitizeSnapshot({ ...row });
  }
}
