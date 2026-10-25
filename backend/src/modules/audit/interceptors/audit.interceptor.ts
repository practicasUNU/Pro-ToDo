import { Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isUUID } from 'class-validator';
import { defer, lastValueFrom } from 'rxjs';

import { extractClientIp } from '@common/utils/client-ip.util';
import { AuditTable } from '@modules/audit/audit-tables';
import { AUDIT_ACTION_KEY } from '@modules/audit/decorators/audit-action.decorator';
import { AuditActionType } from '@modules/audit/enums/audit-action.enum';
import { changedAuditKeys } from '@modules/audit/reports/audit-labels';
import { AuditLoggerService } from '@modules/audit/services/audit-logger.service';
import { AuditSnapshotService } from '@modules/audit/services/audit-snapshot.service';
import { WorkflowStatus } from '@modules/workflows/enums/workflow-status.enum';

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
 * Propiedades que representan la bandera de actividad de un registro.
 *
 * Son DOS porque las entidades no se pusieron de acuerdo: `User` la llama
 * `isActive` y las tres familias de plantillas `active`, aunque todas mapeen la
 * misma columna `activo`. Se miran las dos en vez de normalizar las entidades
 * porque renombrar una propiedad de dominio para que encaje aqui seria dejar
 * que la auditoria dicte el modelo.
 *
 * `AllowedIp` no tiene ninguna —se da de alta o se borra— y no produce
 * `ACTIVAR` / `DESACTIVAR`. `Workflow` tampoco la tiene, pero SI las produce:
 * gobierna su actividad con un estado enumerado y lo resuelve
 * `readWorkflowStatusAction`, aparte.
 */
const ACTIVITY_FLAG_KEYS = ['isActive', 'active'] as const;

/**
 * Bandera de actividad de la fotografia, si la tiene.
 *
 * Devuelve `null` cuando la entidad no declara ninguna o cuando el valor no es
 * booleano: un `undefined` y un `false` significan cosas distintas, y tratarlos
 * igual inventaria una desactivacion en cada alta de una tabla sin bandera.
 */
const readActivityFlag = (snapshot: AuditSnapshot | null): boolean | null => {
  if (snapshot === null) {
    return null;
  }

  for (const key of ACTIVITY_FLAG_KEYS) {
    const value = snapshot[key];

    if (typeof value === 'boolean') {
      return value;
    }
  }

  return null;
};

/**
 * Activacion o desactivacion de un FLUJO, que no tiene bandera booleana.
 *
 * La migracion 040 cambio `flujos.activo BOOLEAN` por `flujos.status`
 * enumerado, de modo que `readActivityFlag` dejo de verlo y armar o retirar un
 * flujo se registraba como un `ACTUALIZAR` indistinguible de cambiarle el
 * nombre. Son justo las dos acciones que un auditor busca por si mismas.
 *
 * Se exige que `status` sea la UNICA clave cambiada. Guardar el grafo y armarlo
 * en la misma peticion es una modificacion con todas las letras: registrarla
 * como `ACTIVAR` afirmaria que solo se cambio el interruptor y escondria la
 * edicion del pipeline, que es el dato mas delicado de la tabla.
 *
 * `PAUSADO` no llega por aqui —el DTO lo rechaza y solo lo escribe el motor—,
 * pero si llegase cuenta como desactivacion: lo unico que afirma la etiqueta es
 * que el flujo dejo de estar armado.
 */
const readWorkflowStatusAction = (
  options: AuditActionOptions,
  previous: AuditSnapshot | null,
  next: AuditSnapshot | null,
): AuditActionType | null => {
  if (
    options.table !== AuditTable.WORKFLOWS ||
    previous === null ||
    next === null
  ) {
    return null;
  }

  const changed = changedAuditKeys(previous, next);

  if (changed.length !== 1 || changed[0] !== 'status') {
    return null;
  }

  return next.status === WorkflowStatus.ACTIVO
    ? AuditActionType.ACTIVATE
    : AuditActionType.DEACTIVATE;
};

/**
 * Afina el `UPDATE` generico del decorador en la accion que de verdad ocurrio.
 *
 * El decorador solo puede declarar lo que el endpoint hace SIEMPRE (`CREATE`,
 * `UPDATE`, `DELETE`); que un `PATCH /users/:id` haya cambiado el rol o haya
 * dado de baja la cuenta no se sabe hasta comparar las dos fotografias. Esa
 * comparacion vive aqui, que es el unico punto que las tiene a la vez.
 *
 * Son las tres acciones que un auditor busca POR SI MISMAS —«quien cambio el
 * rol de esta cuenta», «quien le quito el acceso»— y que, registradas como
 * `ACTUALIZAR`, quedarian enterradas entre ediciones de correo. El orden de las
 * dos reglas no llega a importar: un cambio de rol y un cambio de actividad no
 * pueden ocurrir en la misma peticion porque son endpoints distintos, y si
 * algun dia coincidieran, el rol es lo mas grave y gana.
 *
 * LA REGLA DE ACTIVIDAD ALCANZA TAMBIEN AL `DELETE`, y no es un descuido.
 * `DELETE /users/:id` es un borrado LOGICO: pone `isActive = false` y la fila
 * sigue ahi. Registrarlo como `ELIMINAR` decia que se habia borrado algo que no
 * se borro, y dejaba sin distinguir esa baja de la de una plantilla que si
 * desaparece. No hay riesgo de confundir los dos casos porque la condicion
 * exige que el registro EXISTA despues: un borrado fisico no deja fotografia
 * posterior, `readActivityFlag` devuelve `null` y la accion declarada se
 * respeta tal cual.
 */
const resolveAction = (
  options: AuditActionOptions,
  previous: AuditSnapshot | null,
  next: AuditSnapshot | null,
): AuditActionType => {
  if (options.action === AuditActionType.CREATE) {
    return options.action;
  }

  const isRoleChange =
    options.table === AuditTable.USERS &&
    options.action === AuditActionType.UPDATE &&
    previous !== null &&
    next !== null &&
    previous.role !== next.role;

  if (isRoleChange) {
    return AuditActionType.ROLE_CHANGE;
  }

  const wasActive = readActivityFlag(previous);
  const isActive = readActivityFlag(next);

  // Solo si la bandera existe en AMBAS fotografias y cambio de verdad. Una
  // modificacion que no la toca sigue siendo un `ACTUALIZAR`.
  if (wasActive !== null && isActive !== null && wasActive !== isActive) {
    return isActive ? AuditActionType.ACTIVATE : AuditActionType.DEACTIVATE;
  }

  return readWorkflowStatusAction(options, previous, next) ?? options.action;
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
