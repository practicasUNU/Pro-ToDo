import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of, throwError } from 'rxjs';

import { AuditTable } from '@modules/audit/audit-tables';
import { AUDIT_ACTION_KEY } from '@modules/audit/decorators/audit-action.decorator';
import { AuditActionType } from '@modules/audit/enums/audit-action.enum';
import { AuditInterceptor } from '@modules/audit/interceptors/audit.interceptor';

import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { AuditActionOptions } from '@modules/audit/decorators/audit-action.decorator';
import type { AuditLoggerService } from '@modules/audit/services/audit-logger.service';
import type { AuditSnapshotService } from '@modules/audit/services/audit-snapshot.service';

const ACTOR_ID = '3f1c2b64-8a5e-4c2f-9d3a-7b6e5f4c1a20';
const TARGET_ID = 'b27d9e10-4c3f-4a8b-9f21-6d5e4c3b2a19';
const CLIENT_IP = '192.168.1.20';

interface RequestStub {
  readonly params: Record<string, string>;
  readonly headers: Record<string, string>;
  readonly user?: { id: string };
}

/** Handler con metadatos: `Reflector.get` los lee de esta funcion. */
const buildHandler = (options?: AuditActionOptions): (() => void) => {
  const handler = (): void => undefined;

  if (options !== undefined) {
    Reflect.defineMetadata(AUDIT_ACTION_KEY, options, handler);
  }

  return handler;
};

const buildContext = (
  handler: () => void,
  request: RequestStub,
): ExecutionContext =>
  ({
    getType: () => 'http',
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

const buildRequest = (overrides: Partial<RequestStub> = {}): RequestStub => ({
  params: { id: TARGET_ID },
  headers: { 'x-forwarded-for': CLIENT_IP },
  user: { id: ACTOR_ID },
  ...overrides,
});

const buildInterceptor = () => {
  const snapshots = { load: jest.fn().mockResolvedValue(null) };
  const auditLogger = { record: jest.fn().mockResolvedValue(undefined) };
  const interceptor = new AuditInterceptor(
    new Reflector(),
    snapshots as unknown as AuditSnapshotService,
    auditLogger as unknown as AuditLoggerService,
  );

  return { interceptor, snapshots, auditLogger };
};

const run = (
  interceptor: AuditInterceptor,
  context: ExecutionContext,
  handler: CallHandler,
): Promise<unknown> => lastValueFrom(interceptor.intercept(context, handler));

describe('AuditInterceptor', () => {
  it('1.1 deberia registrar un UPDATE con la fotografia anterior y la nueva', async () => {
    // 1. Arrange 📐
    const { interceptor, snapshots, auditLogger } = buildInterceptor();
    snapshots.load
      .mockResolvedValueOnce({ name: 'Antes' })
      .mockResolvedValueOnce({ name: 'Despues' });
    const context = buildContext(
      buildHandler({
        table: AuditTable.WORKFLOWS,
        action: AuditActionType.UPDATE,
      }),
      buildRequest(),
    );

    // 2. Act ⚙️
    const response = await run(interceptor, context, {
      handle: () => of({ id: TARGET_ID, name: 'Despues' }),
    });

    // 3. Assert 🎯
    expect(response).toEqual({ id: TARGET_ID, name: 'Despues' });
    expect(auditLogger.record).toHaveBeenCalledWith({
      userId: ACTOR_ID,
      action: AuditActionType.UPDATE,
      affectedTable: AuditTable.WORKFLOWS,
      recordId: TARGET_ID,
      previousData: { name: 'Antes' },
      newData: { name: 'Despues' },
      sourceIp: CLIENT_IP,
    });
  });

  it('1.2 deberia registrar ROLE_CHANGE cuando un UPDATE de usuarios cambia el rol', async () => {
    // 1. Arrange 📐
    const { interceptor, snapshots, auditLogger } = buildInterceptor();
    snapshots.load
      .mockResolvedValueOnce({ email: 'e@unuware.com', role: 'EDITOR' })
      .mockResolvedValueOnce({ email: 'e@unuware.com', role: 'ADMIN' });
    const context = buildContext(
      buildHandler({ table: AuditTable.USERS, action: AuditActionType.UPDATE }),
      buildRequest(),
    );

    // 2. Act ⚙️
    await run(interceptor, context, { handle: () => of({ id: TARGET_ID }) });

    // 3. Assert 🎯
    expect(auditLogger.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditActionType.ROLE_CHANGE }),
    );
  });

  it('1.3 deberia tomar el id de la respuesta en un CREATE y no leer el "antes"', async () => {
    // 1. Arrange 📐
    const { interceptor, snapshots, auditLogger } = buildInterceptor();
    snapshots.load.mockResolvedValue({ ipOrCidr: '10.0.0.0/8' });
    const context = buildContext(
      buildHandler({
        table: AuditTable.ALLOWED_IPS,
        action: AuditActionType.CREATE,
      }),
      buildRequest({ params: {} }),
    );

    // 2. Act ⚙️
    await run(interceptor, context, { handle: () => of({ id: TARGET_ID }) });

    // 3. Assert 🎯
    expect(snapshots.load).toHaveBeenCalledTimes(1);
    expect(snapshots.load).toHaveBeenCalledWith(
      AuditTable.ALLOWED_IPS,
      TARGET_ID,
    );
    expect(auditLogger.record).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: TARGET_ID,
        previousData: null,
        newData: { ipOrCidr: '10.0.0.0/8' },
      }),
    );
  });

  it('1.4 NO deberia registrar nada si el handler falla', async () => {
    // 1. Arrange 📐
    const { interceptor, auditLogger } = buildInterceptor();
    const context = buildContext(
      buildHandler({
        table: AuditTable.HTML_TEMPLATES,
        action: AuditActionType.DELETE,
      }),
      buildRequest(),
    );

    // 2. Act ⚙️ + 3. Assert 🎯
    await expect(
      run(interceptor, context, {
        handle: () => throwError(() => new NotFoundException()),
      }),
    ).rejects.toThrow(NotFoundException);
    expect(auditLogger.record).not.toHaveBeenCalled();
  });

  it('1.5 deberia dejar pasar sin coste un handler sin @AuditAction', async () => {
    // 1. Arrange 📐
    const { interceptor, snapshots, auditLogger } = buildInterceptor();
    const context = buildContext(buildHandler(), buildRequest());

    // 2. Act ⚙️
    const response = await run(interceptor, context, {
      handle: () => of('lectura'),
    });

    // 3. Assert 🎯
    expect(response).toBe('lectura');
    expect(snapshots.load).not.toHaveBeenCalled();
    expect(auditLogger.record).not.toHaveBeenCalled();
  });

  it('1.6 deberia seguir registrando aunque falle la lectura de una fotografia', async () => {
    // 1. Arrange 📐
    const { interceptor, snapshots, auditLogger } = buildInterceptor();
    snapshots.load.mockRejectedValue(new Error('timeout'));
    const context = buildContext(
      buildHandler({ table: AuditTable.USERS, action: AuditActionType.DELETE }),
      buildRequest(),
    );

    // 2. Act ⚙️
    await run(interceptor, context, { handle: () => of({ id: TARGET_ID }) });

    // 3. Assert 🎯
    expect(auditLogger.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditActionType.DELETE,
        previousData: null,
        newData: null,
      }),
    );
  });

  it('1.7 no deberia consultar la BD con un id que no es UUID', async () => {
    // 1. Arrange 📐: `ParseUUIDPipe` lo rechazara con 400 dentro del handler.
    const { interceptor, snapshots } = buildInterceptor();
    const context = buildContext(
      buildHandler({ table: AuditTable.USERS, action: AuditActionType.UPDATE }),
      buildRequest({ params: { id: 'no-es-uuid' } }),
    );

    // 2. Act ⚙️
    await run(interceptor, context, { handle: () => of({}) });

    // 3. Assert 🎯
    expect(snapshots.load).not.toHaveBeenCalled();
  });
});
