import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { resolveDateRange } from '@common/utils/date-range.util';
import {
  DEFAULT_AUDIT_LIMIT,
  DEFAULT_AUDIT_RANGE_DAYS,
} from '@modules/audit/dto/list-audit-events-query.dto';
import { AuditEvento } from '@modules/audit/entities/audit-evento.entity';

import type { SelectQueryBuilder } from 'typeorm';
import type { DateRange } from '@common/utils/date-range.util';
import type {
  AuditEventsFilterDto,
  ListAuditEventsQueryDto,
} from '@modules/audit/dto/list-audit-events-query.dto';
import type {
  AuditEventPageResponseDto,
  AuditEventResponseDto,
} from '@modules/audit/dto/audit-event-response.dto';
import type { AuditActionType } from '@modules/audit/enums/audit-action.enum';
import type { AuditSnapshot } from '@modules/audit/services/audit-snapshot.service';

/**
 * Techo de filas de una exportacion, mismo criterio que la telemetria: el CSV
 * no pagina y un rango largo no debe montarse entero en memoria.
 */
export const MAX_AUDIT_EXPORT_ROWS = 50_000;

/** Un evento listo para insertar. */
export interface AuditRecordInput {
  readonly userId: string | null;
  readonly action: AuditActionType;
  readonly affectedTable: string;
  readonly recordId: string | null;
  readonly previousData?: AuditSnapshot | null;
  readonly newData?: AuditSnapshot | null;
  readonly sourceIp: string | null;
}

/** Resultado de una exportacion: las filas y si se cortaron en el techo. */
export interface AuditExportRows {
  readonly range: DateRange;
  readonly items: AuditEventResponseDto[];
  readonly truncated: boolean;
}

const toResponse = (event: AuditEvento): AuditEventResponseDto => ({
  id: event.id,
  createdAt: event.createdAt.toISOString(),
  userId: event.userId,
  userEmail: event.user?.email ?? null,
  action: event.action,
  affectedTable: event.affectedTable,
  recordId: event.recordId,
  previousData: event.previousData,
  newData: event.newData,
  sourceIp: event.sourceIp,
});

/**
 * Registro y consulta del historial de acciones humanas (`audit_eventos`).
 *
 * `record` es BEST-EFFORT: la mutacion que se audita ya esta confirmada cuando
 * se llama, y convertir un fallo del registro en un 500 haria creer al usuario
 * que su cambio no se guardo (y a reintentarlo). El fallo se deja en el log del
 * servidor con todo lo necesario para reconstruirlo.
 */
@Injectable()
export class AuditLoggerService {
  private readonly logger = new Logger(AuditLoggerService.name);

  constructor(
    @InjectRepository(AuditEvento)
    private readonly auditRepository: Repository<AuditEvento>,
  ) {}

  public async record(input: AuditRecordInput): Promise<void> {
    try {
      // `create` + `save` y no `insert`: el tipado de `insert` no admite un
      // `Record` arbitrario en una columna JSONB.
      const event = this.auditRepository.create({
        userId: input.userId,
        action: input.action,
        affectedTable: input.affectedTable,
        recordId: input.recordId,
        previousData: input.previousData ?? null,
        newData: input.newData ?? null,
        sourceIp: input.sourceIp,
      });
      await this.auditRepository.save(event);
    } catch (error) {
      this.logger.warn(
        `No se pudo registrar el evento de auditoria ${input.action} sobre ${input.affectedTable}/${input.recordId ?? '-'} (usuario ${input.userId ?? '-'}): ${(error as Error).message}`,
      );
    }
  }

  /** Pagina del historial, del mas reciente al mas antiguo. */
  public async findPage(
    query: ListAuditEventsQueryDto,
  ): Promise<AuditEventPageResponseDto> {
    const limit = query.limit ?? DEFAULT_AUDIT_LIMIT;
    const offset = query.offset ?? 0;
    const range = resolveDateRange(query, DEFAULT_AUDIT_RANGE_DAYS);

    const [events, total] = await this.filteredEvents(query, range)
      .take(limit)
      .skip(offset)
      .getManyAndCount();

    return { items: events.map(toResponse), total, limit, offset };
  }

  /**
   * Filas de una exportacion. Pide una mas del techo para saber si se corto
   * sin lanzar un COUNT aparte.
   */
  public async getExportRows(
    query: AuditEventsFilterDto,
  ): Promise<AuditExportRows> {
    const range = resolveDateRange(query, DEFAULT_AUDIT_RANGE_DAYS);
    const events = await this.filteredEvents(query, range)
      .take(MAX_AUDIT_EXPORT_ROWS + 1)
      .getMany();

    return {
      range,
      items: events.slice(0, MAX_AUDIT_EXPORT_ROWS).map(toResponse),
      truncated: events.length > MAX_AUDIT_EXPORT_ROWS,
    };
  }

  /**
   * `creado_en` es `TIMESTAMPTZ`, pero el rango se envia igualmente como ISO
   * UTC y con `CAST`: `pg` serializa un `Date` en la zona LOCAL del proceso y
   * asi la comparacion no depende de ella.
   */
  private filteredEvents(
    filters: AuditEventsFilterDto,
    range: DateRange,
  ): SelectQueryBuilder<AuditEvento> {
    const builder = this.auditRepository
      .createQueryBuilder('e')
      .leftJoin('e.user', 'u')
      .addSelect(['u.id', 'u.email'])
      .where('e.creado_en >= CAST(:from AS timestamptz)', {
        from: range.from.toISOString(),
      })
      .andWhere('e.creado_en < CAST(:to AS timestamptz)', {
        to: range.to.toISOString(),
      })
      .orderBy('e.creado_en', 'DESC');

    if (filters.userId !== undefined) {
      builder.andWhere('e.usuario_id = :userId', { userId: filters.userId });
    }

    if (filters.affectedTable !== undefined) {
      builder.andWhere('e.tabla_afectada = :affectedTable', {
        affectedTable: filters.affectedTable,
      });
    }

    if (filters.action !== undefined) {
      builder.andWhere('e.accion = :action', { action: filters.action });
    }

    return builder;
  }
}
