import { SetMetadata } from '@nestjs/common';

import type { AuditTable } from '@modules/audit/audit-tables';
import type { AuditActionType } from '@modules/audit/enums/audit-action.enum';

/** Clave de metadatos que lee `AuditInterceptor`. */
export const AUDIT_ACTION_KEY = 'audit:action';

/** Que audita un endpoint de mutacion. */
export interface AuditActionOptions {
  readonly table: AuditTable;
  readonly action:
    AuditActionType.CREATE | AuditActionType.UPDATE | AuditActionType.DELETE;
  /** Parametro de ruta con el id del registro. Por defecto, `id`. */
  readonly idParam?: string;
}

/**
 * Marca un endpoint de mutacion para que `AuditInterceptor` (global) registre
 * el evento en `audit_eventos` cuando la peticion termina BIEN.
 *
 * Solo pone metadatos: el controlador no necesita importar `AuditModule`, y un
 * endpoint sin decorar no paga nada.
 */
export const AuditAction = (options: AuditActionOptions) =>
  SetMetadata(AUDIT_ACTION_KEY, options);
