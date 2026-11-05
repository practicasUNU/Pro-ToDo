import { CrudEventsCoordinator } from '@common/services/crud-events.coordinator';
import { AuditTable } from '@modules/audit/audit-tables';
import { AuditActionType } from '@modules/audit/enums/audit-action.enum';
import {
  AUDIT_CSV_HEADERS,
  buildAuditCsv,
} from '@modules/audit/reports/audit-csv.builder';
import { AuditPdfRenderer } from '@modules/audit/reports/audit-pdf.renderer';
import {
  AuditLoggerService,
  MAX_AUDIT_EXPORT_ROWS,
} from '@modules/audit/services/audit-logger.service';

import type { Repository } from 'typeorm';
import type { AuditEventResponseDto } from '@modules/audit/dto/audit-event-response.dto';
import type { AuditEvento } from '@modules/audit/entities/audit-evento.entity';
import type { BrowserPoolService } from '@modules/nodes/services/browser-pool.service';

const ACTOR_ID = '3f1c2b64-8a5e-4c2f-9d3a-7b6e5f4c1a20';
const TARGET_ID = 'b27d9e10-4c3f-4a8b-9f21-6d5e4c3b2a19';

/** Eslabones encadenables de un `SelectQueryBuilder`, todos devolviendo la cadena. */
const CHAIN_METHODS = [
  'leftJoin',
  'addSelect',
  'where',
  'andWhere',
  'orderBy',
  'addOrderBy',
  'take',
  'skip',
] as const;

type QueryBuilderMock = Record<(typeof CHAIN_METHODS)[number], jest.Mock> & {
  getMany: jest.Mock;
  getManyAndCount: jest.Mock;
};

const buildQueryBuilder = (): QueryBuilderMock => {
  const builder = {
    getMany: jest.fn().mockResolvedValue([]),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
  } as Partial<QueryBuilderMock>;

  for (const method of CHAIN_METHODS) {
    builder[method] = jest.fn(() => builder);
  }

  return builder as QueryBuilderMock;
};

const buildRepository = () => {
  const builder = buildQueryBuilder();
  const repository = {
    create: jest.fn((entity: Partial<AuditEvento>) => entity),
    save: jest.fn((entity: Partial<AuditEvento>) => Promise.resolve(entity)),
    createQueryBuilder: jest.fn(() => builder),
  };

  return { repository, builder };
};

const buildService = (
  repository: ReturnType<typeof buildRepository>['repository'],
) =>
  // El coordinador REAL y no un doble: sin puertos inscritos `dispatch` es un
  // no-op silencioso, que es justo lo que hace falta aqui. Omitirlo dejaba un
  // `undefined` que el `catch` de `record` tragaba, y cada prueba pasaba por
  // el camino del error creyendo que probaba el del exito.
  new AuditLoggerService(
    repository as unknown as Repository<AuditEvento>,
    new CrudEventsCoordinator(),
  );

/** Evento tal como lo devuelve TypeORM, con el usuario parcial del JOIN. */
const buildRow = (index: number): AuditEvento =>
  ({
    id: `evt-${index}`,
    createdAt: new Date('2026-10-22T08:30:00.000Z'),
    userId: ACTOR_ID,
    user: { id: ACTOR_ID, email: 'admin@unuware.com' },
    action: AuditActionType.ROLE_CHANGE,
    affectedTable: AuditTable.USERS,
    recordId: TARGET_ID,
    previousData: { email: 'editor@unuware.com', role: 'EDITOR' },
    newData: { email: 'editor@unuware.com', role: 'ADMIN' },
    sourceIp: '192.168.1.20',
  }) as unknown as AuditEvento;

const buildEvent = (
  overrides: Partial<AuditEventResponseDto> = {},
): AuditEventResponseDto => ({
  id: 'evt-1',
  createdAt: '2026-10-22T08:30:00.000Z',
  userId: ACTOR_ID,
  userEmail: 'admin@unuware.com',
  action: AuditActionType.ROLE_CHANGE,
  affectedTable: AuditTable.USERS,
  recordId: TARGET_ID,
  previousData: { email: 'editor@unuware.com', role: 'EDITOR' },
  newData: { email: 'editor@unuware.com', role: 'ADMIN' },
  sourceIp: '192.168.1.20',
  ...overrides,
});

describe('AuditLoggerService', () => {
  describe('record', () => {
    it('1.1 deberia persistir el evento con actor, IP y las dos fotografias', async () => {
      // 1. Arrange 📐
      const { repository } = buildRepository();
      const service = buildService(repository);

      // 2. Act ⚙️
      await service.record({
        userId: ACTOR_ID,
        action: AuditActionType.UPDATE,
        affectedTable: AuditTable.WORKFLOWS,
        recordId: TARGET_ID,
        previousData: { name: 'Antes' },
        newData: { name: 'Despues' },
        sourceIp: '10.0.0.7',
      });

      // 3. Assert 🎯
      expect(repository.save).toHaveBeenCalledWith({
        userId: ACTOR_ID,
        action: AuditActionType.UPDATE,
        affectedTable: AuditTable.WORKFLOWS,
        recordId: TARGET_ID,
        previousData: { name: 'Antes' },
        newData: { name: 'Despues' },
        sourceIp: '10.0.0.7',
      });
    });

    it('1.2 deberia guardar null en las fotografias que no se informan', async () => {
      // 1. Arrange 📐: un login no tiene "antes".
      const { repository } = buildRepository();
      const service = buildService(repository);

      // 2. Act ⚙️
      await service.record({
        userId: null,
        action: AuditActionType.LOGIN_FAILED,
        affectedTable: AuditTable.USERS,
        recordId: null,
        sourceIp: null,
      });

      // 3. Assert 🎯
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ previousData: null, newData: null }),
      );
    });

    it('1.2b deberia omitir el autor desconocido para que el DEFAULT ponga la cuenta de respaldo', async () => {
      // 1. Arrange 📐: accion de sistema sin JWT (migracion 060).
      const { repository } = buildRepository();
      const service = buildService(repository);

      // 2. Act ⚙️
      await service.record({
        userId: null,
        action: AuditActionType.DEACTIVATE,
        affectedTable: AuditTable.WORKFLOWS,
        recordId: TARGET_ID,
        sourceIp: null,
      });

      // 3. Assert 🎯: sin la clave TypeORM escribe DEFAULT, no NULL.
      const [entity] = repository.save.mock.calls[0];
      expect(entity).not.toHaveProperty('userId');
    });

    it('1.2c deberia conservar el NULL explicito en un login fallido', async () => {
      // 1. Arrange 📐: atribuirlo a una cuenta real falsearia la traza.
      const { repository } = buildRepository();
      const service = buildService(repository);

      // 2. Act ⚙️
      await service.record({
        userId: null,
        action: AuditActionType.LOGIN_FAILED,
        affectedTable: AuditTable.USERS,
        recordId: null,
        sourceIp: null,
      });

      // 3. Assert 🎯
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ userId: null }),
      );
    });

    it('1.3 NO deberia lanzar si la base de datos falla (best-effort)', async () => {
      // 1. Arrange 📐: la mutacion auditada ya esta confirmada.
      const { repository } = buildRepository();
      repository.save.mockRejectedValue(new Error('connection terminated'));
      const service = buildService(repository);

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(
        service.record({
          userId: ACTOR_ID,
          action: AuditActionType.DELETE,
          affectedTable: AuditTable.ALLOWED_IPS,
          recordId: TARGET_ID,
          sourceIp: null,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('findPage', () => {
    it('2.1 deberia aplicar los filtros y proyectar el correo del actor', async () => {
      // 1. Arrange 📐
      const { repository, builder } = buildRepository();
      builder.getManyAndCount.mockResolvedValue([[buildRow(1)], 1]);
      const service = buildService(repository);

      // 2. Act ⚙️
      const page = await service.findPage({
        userId: ACTOR_ID,
        affectedTable: AuditTable.USERS,
        action: AuditActionType.ROLE_CHANGE,
        from: '2026-10-01',
        to: '2026-10-22',
        limit: 10,
        offset: 20,
      });

      // 3. Assert 🎯
      expect(builder.andWhere).toHaveBeenCalledWith('e.usuario_id = :userId', {
        userId: ACTOR_ID,
      });
      expect(builder.andWhere).toHaveBeenCalledWith(
        'e.tabla_afectada = :affectedTable',
        { affectedTable: AuditTable.USERS },
      );
      expect(builder.andWhere).toHaveBeenCalledWith('e.accion = :action', {
        action: AuditActionType.ROLE_CHANGE,
      });
      expect(builder.take).toHaveBeenCalledWith(10);
      expect(builder.skip).toHaveBeenCalledWith(20);
      expect(page).toMatchObject({ total: 1, limit: 10, offset: 20 });
      expect(page.items[0]).toMatchObject({
        userEmail: 'admin@unuware.com',
        createdAt: '2026-10-22T08:30:00.000Z',
      });
    });

    it('2.2 deberia enviar el rango como ISO UTC con CAST a timestamptz', async () => {
      // 1. Arrange 📐
      const { repository, builder } = buildRepository();
      const service = buildService(repository);

      // 2. Act ⚙️
      await service.findPage({ from: '2026-10-01', to: '2026-10-22' });

      // 3. Assert 🎯: `to` sin hora incluye el dia completo.
      expect(builder.where).toHaveBeenCalledWith(
        'e.creado_en >= CAST(:from AS timestamptz)',
        { from: '2026-10-01T00:00:00.000Z' },
      );
      expect(builder.andWhere).toHaveBeenCalledWith(
        'e.creado_en < CAST(:to AS timestamptz)',
        { to: '2026-10-23T00:00:00.000Z' },
      );
    });

    it('2.3 deberia ordenar el historial entero por la columna de la lista blanca', async () => {
      // 1. Arrange 📐: `user` es el correo del actor unido, no un campo de la fila.
      const { repository, builder } = buildRepository();
      const service = buildService(repository);

      // 2. Act ⚙️
      await service.findPage({ sortBy: 'user', sortOrder: 'ASC' });

      // 3. Assert 🎯
      expect(builder.orderBy).toHaveBeenLastCalledWith(
        'u.email',
        'ASC',
        'NULLS LAST',
      );
      expect(builder.addOrderBy).toHaveBeenLastCalledWith('e.id', 'ASC');
    });

    it('2.4 deberia caer al orden por fecha descendente sin criterio', async () => {
      // 1. Arrange 📐
      const { repository, builder } = buildRepository();
      const service = buildService(repository);

      // 2. Act ⚙️
      await service.findPage({});

      // 3. Assert 🎯
      expect(builder.orderBy).toHaveBeenLastCalledWith(
        'e.createdAt',
        'DESC',
        'NULLS LAST',
      );
    });
  });

  describe('getExportRows', () => {
    it('3.1 deberia marcar truncated cuando hay mas filas que el techo', async () => {
      // 1. Arrange 📐: el servicio pide una fila de mas para detectarlo.
      const { repository, builder } = buildRepository();
      builder.getMany.mockResolvedValue(
        Array.from({ length: MAX_AUDIT_EXPORT_ROWS + 1 }, (_, i) =>
          buildRow(i),
        ),
      );
      const service = buildService(repository);

      // 2. Act ⚙️
      const result = await service.getExportRows({});

      // 3. Assert 🎯
      expect(builder.take).toHaveBeenCalledWith(MAX_AUDIT_EXPORT_ROWS + 1);
      expect(result.items).toHaveLength(MAX_AUDIT_EXPORT_ROWS);
      expect(result.truncated).toBe(true);
    });
  });

  describe('informe CSV', () => {
    it('4.1 deberia volcar cabecera, etiquetas en castellano y campos modificados', () => {
      // 1. Arrange 📐
      const events = [buildEvent()];

      // 2. Act ⚙️
      const csv = buildAuditCsv(events).toString('utf8');
      const [header, row] = csv.replace('﻿', '').split('\r\n');

      // 3. Assert 🎯
      expect(header).toBe(AUDIT_CSV_HEADERS.join(';'));
      expect(row).toContain('admin@unuware.com;Cambio de rol;Usuarios');
      expect(row).toContain(';role;');
      expect(row).toContain(
        '"{""email"":""editor@unuware.com"",""role"":""ADMIN""}"',
      );
    });

    it('4.2 deberia neutralizar una formula en un valor escrito por un usuario', () => {
      // 1. Arrange 📐: correo manipulado para ejecutarse en la hoja de calculo.
      const events = [buildEvent({ userEmail: '=HYPERLINK("http://x")' })];

      // 2. Act ⚙️
      const csv = buildAuditCsv(events).toString('utf8');

      // 3. Assert 🎯
      expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    });
  });

  describe('informe PDF', () => {
    const buildRenderer = () => {
      const page = {
        setContent: jest.fn().mockResolvedValue(undefined),
        pdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.7 fake')),
      };
      const context = {
        newPage: jest.fn().mockResolvedValue(page),
        close: jest.fn().mockResolvedValue(undefined),
      };
      const pool = { createContext: jest.fn().mockResolvedValue(context) };
      const renderer = new AuditPdfRenderer(
        pool as unknown as BrowserPoolService,
      );

      return { renderer, page, context };
    };

    const buildInput = (items: AuditEventResponseDto[]) => ({
      range: {
        from: new Date('2026-10-01T00:00:00.000Z'),
        to: new Date('2026-10-23T00:00:00.000Z'),
      },
      filters: { action: AuditActionType.ROLE_CHANGE },
      items,
      truncated: false,
      requestedBy: 'admin@unuware.com',
    });

    it('5.1 deberia pintar KPIs, filtros, campos modificados y la firma', () => {
      // 1. Arrange 📐
      const { renderer } = buildRenderer();
      const items = [
        buildEvent(),
        buildEvent({
          id: 'evt-2',
          action: AuditActionType.LOGIN_FAILED,
          previousData: null,
          newData: { email: 'intruso@unuware.com' },
        }),
      ];

      // 2. Act ⚙️
      const html = renderer.renderHtml(buildInput(items));

      // 3. Assert 🎯
      expect(html).toContain('Informe de auditoría de acciones');
      expect(html).toContain('Filtros aplicados: acción Cambio de rol');
      expect(html).toContain(
        '<span class="failed">Inicio de sesión fallido</span>',
      );
      expect(html).toContain('<td class="mono">role</td>');
      expect(html).toContain('admin@unuware.com');
    });

    it('5.2 deberia imprimir el PDF y cerrar siempre el contexto', async () => {
      // 1. Arrange 📐
      const { renderer, page, context } = buildRenderer();
      page.pdf.mockRejectedValueOnce(new Error('Target closed'));

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(renderer.render(buildInput([]))).rejects.toThrow(
        'Target closed',
      );
      expect(context.close).toHaveBeenCalledTimes(1);

      const pdf = await renderer.render(buildInput([buildEvent()]));
      expect(pdf.toString().startsWith('%PDF')).toBe(true);
      expect(page.pdf).toHaveBeenLastCalledWith(
        expect.objectContaining({ format: 'A4' }),
      );
    });
  });
});
