import { Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isUUID } from 'class-validator';
import { defer, lastValueFrom } from 'rxjs';

import { extractClientIp } from '@common/utils/client-ip.util';
import { AuditTable } from '@modules/audit/audit-tables';
import { AUDIT_ACTION_KEY } from '@modules/audit/decorators/audit-action.decorator';
import { AuditActionType } from '@modules/audit/enums/audit-action.enum';
import { AuditLoggerService } from '@modules/audit/services/audit-logger.service';
import { AuditSnapshotService } from '@modules/audit/services/audit-snapshot.service';

import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import type { AuditActionOptions } from '@modules/audit/decorators/audit-action.decorator';
import type { AuditSnapshot } from '@modules/audit/services/audit-snapshot.service';
import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';

/** Peticion HTTP con el usuario que deja `JwtAuthGuard`. */
type AuditedRequest = Request & { user?: AuthenticatedUser };

/** Id del registro creado: todas las respuestas de alta lo exponen como `id`. */
const readResponseId = (response: unknown): string | null => {
  if (typeof response !== 'object' || response === null) {
    return null;
  }

  const { id } = response as { id?: unknown };

  return typeof id === 'string' ? id : null;
};

/**
 * Un UPDATE de `usuarios` que cambia el rol se registra como `ROLE_CHANGE`:
 * es la accion que mas interesa encontrar y, como UPDATE generico, quedaria
 * enterrada entre ediciones de correo y bajas.
 */
const resolveAction = (
  options: AuditActionOptions,
  previous: AuditSnapshot | null,
  next: AuditSnapshot | null,
): AuditActionType => {
  const isRoleChange =
    options.table === AuditTable.USERS &&
    options.action === AuditActionType.UPDATE &&
    previous !== null &&
    next !== null &&
    previous.role !== next.role;

  return isRoleChange ? AuditActionType.ROLE_CHANGE : options.action;
};

/**
 * Registra en `audit_eventos` las mutaciones de los endpoints marcados con
 * `@AuditAction` (global, `APP_INTERCEPTOR`).
 *
 * Por que un interceptor y no una llamada en cada servicio: es el unico punto
 * que conoce A LA VEZ al actor (`req.user`), la IP de origen y el desenlace de
 * la peticion, sin pasar la IP por una docena de firmas de servicio.
 *
 * ORDEN: la fotografia ANTERIOR se toma antes de ejecutar el handler; la
 * POSTERIOR, solo si el handler termina bien. Una peticion que falla (400, 404,
 * 409...) no cambio nada y no deja evento. El registro se espera antes de
 * responder para que un test o un cliente que consulte justo despues lo vea,
 * pero nunca lanza (`AuditLoggerService.record` es best-effort).
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly snapshots: AuditSnapshotService,
    private readonly auditLogger: AuditLoggerService,
  ) {}

  public intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const options = this.reflector.get<AuditActionOptions | undefined>(
      AUDIT_ACTION_KEY,
      context.getHandler(),
    );

    if (options === undefined || context.getType() !== 'http') {
      return next.handle();
    }

    return defer(() => this.audit(context, next, options));
  }

  private async audit(
    context: ExecutionContext,
    next: CallHandler,
    options: AuditActionOptions,
  ): Promise<unknown> {
    const request = context.switchToHttp().getRequest<AuditedRequest>();
    const rawParamId = request.params?.[options.idParam ?? 'id'];
    // Un id que no es UUID lo rechazara `ParseUUIDPipe` con un 400: no tiene
    // sentido consultarlo antes (PostgreSQL fallaria al convertirlo).
    const paramId =
      typeof rawParamId === 'string' && isUUID(rawParamId) ? rawParamId : null;
    const previous =
      options.action === AuditActionType.CREATE || paramId === null
        ? null
        : await this.safeSnapshot(options.table, paramId);

    // Si el handler lanza, la excepcion sube tal cual y no se registra nada.
    const response: unknown = await lastValueFrom(next.handle(), {
      defaultValue: undefined,
    });

    const recordId = paramId ?? readResponseId(response);
    const current =
      recordId === null
        ? null
        : await this.safeSnapshot(options.table, recordId);

    await this.auditLogger.record({
      userId: request.user?.id ?? null,
      action: resolveAction(options, previous, current),
      affectedTable: options.table,
      recordId,
      previousData: previous,
      newData: current,
      sourceIp: extractClientIp(request),
    });

    return response;
  }

  /**
   * Fotografia que no puede tumbar la peticion: un fallo al leerla deja el
   * evento sin datos, pero la mutacion sigue su curso.
   */
  private async safeSnapshot(
    table: AuditTable,
    id: string,
  ): Promise<AuditSnapshot | null> {
    try {
      return await this.snapshots.load(table, id);
    } catch (error) {
      this.logger.warn(
        `No se pudo leer la fotografia de ${table}/${id} para auditoria: ${(error as Error).message}`,
      );
      return null;
    }
  }
}
