import { ConflictException, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';

import { PricingEventsCoordinator } from '@common/services/pricing-events.coordinator';
import { stampCreated } from '@common/utils/audit.util';
import { resolveDateRange } from '@common/utils/date-range.util';
import { resolveSort } from '@common/utils/sort-whitelist.util';
import { AuditTable } from '@modules/audit/audit-tables';
import { AuditActionType } from '@modules/audit/enums/audit-action.enum';
import { AuditLoggerService } from '@modules/audit/services/audit-logger.service';
import { PrecioModeloIa } from '@modules/telemetry/entities/precio-modelo-ia.entity';

import {
  DEFAULT_PRICING_LIMIT,
  PRICING_RANGE_DAYS,
  PRICING_SORT_COLUMNS,
} from './dto/list-pricing-query.dto';
import { toPricingResponse } from './dto/pricing-response.dto';

import type { CreatePricingDto } from './dto/create-pricing.dto';
import type { ListPricingQueryDto } from './dto/list-pricing-query.dto';
import type {
  PricingPageResponseDto,
  PricingResponseDto,
} from './dto/pricing-response.dto';
import type { EntityManager } from 'typeorm';

/** SQLSTATE de `unique_violation`. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Restricciones cuyo choque significa "otro ADMIN acaba de registrar una
 * tarifa para el mismo par": el indice parcial de la vigente (migracion 052) y
 * la unicidad de vigencia (dos altas en el mismo instante).
 */
const PRICING_UNIQUE_CONSTRAINTS: ReadonlySet<string> = new Set([
  'uq_precios_modelos_ia_activa',
  'uq_precios_modelos_ia_vigencia',
]);

/** Relaciones de los autores, para proyectar `createdBy`/`updatedBy`. */
const AUTHOR_RELATIONS = { createdBy: true, updatedBy: true } as const;

interface PostgresDriverError {
  readonly code?: string;
  readonly constraint?: string;
}

/** Resultado del relevo, ANTES de anunciarlo. */
interface PricingRelay {
  readonly created: PrecioModeloIa;
  readonly superseded: PrecioModeloIa | null;
}

/**
 * Escapa los comodines de `LIKE` para que el buscador sea literal: sin esto,
 * buscar `%` devolveria la tabla entera y `_` casaria cualquier caracter.
 * PostgreSQL usa `\` como escape por defecto en `LIKE`/`ILIKE`.
 */
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, '\\$&');

/** Fotografia minima para el evento de auditoria del relevo. */
const toAuditSnapshot = (row: PrecioModeloIa): Record<string, unknown> => ({
  id: row.id,
  aiProvider: row.aiProvider,
  aiModel: row.aiModel,
  promptRateUsdPerMTok: row.promptRateUsdPerMTok,
  completionRateUsdPerMTok: row.completionRateUsdPerMTok,
  reasoningRateUsdPerMTok: row.reasoningRateUsdPerMTok,
  validFrom: row.validFrom.toISOString(),
  active: row.active,
});

/**
 * CRUD de tarifas de modelos de IA (`precios_modelos_ia`), exclusivo de ADMIN.
 *
 * El "CRUD" es deliberadamente asimetrico: se puede LEER y se puede REGISTRAR
 * una tarifa, pero no editarla en sitio ni darla de baja. La tabla es un
 * historial versionado: cada inferencia guarda su propia copia de las tarifas
 * (`telemetria_tokens_ia`), y la tabla de precios es el registro de que regia
 * cuando. Editar una fila reescribiria ese registro; darla de baja sin relevo
 * dejaria el par sin tarifa y todo su coste pasaria a "estimado".
 */
@Injectable()
export class PricingService {
  constructor(
    @InjectRepository(PrecioModeloIa)
    private readonly pricingRepository: Repository<PrecioModeloIa>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly auditLogger: AuditLoggerService,
    private readonly pricingEvents: PricingEventsCoordinator,
  ) {}

  /** Pagina de tarifas con buscador, rango de vigencia y orden en servidor. */
  public async findPage(
    query: ListPricingQueryDto,
  ): Promise<PricingPageResponseDto> {
    const limit = query.limit ?? DEFAULT_PRICING_LIMIT;
    const offset = query.offset ?? 0;
    const sort = resolveSort(
      PRICING_SORT_COLUMNS,
      query.sortBy,
      query.sortOrder,
      {
        key: 'validFrom',
        order: 'DESC',
      },
    );

    const builder = this.pricingRepository
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.createdBy', 'cb')
      .leftJoinAndSelect('p.updatedBy', 'ub')
      .orderBy(sort.column, sort.order)
      // El id desempata para que la paginacion sea estable entre peticiones.
      .addOrderBy('p.id', sort.order);

    if (query.search !== undefined && query.search !== '') {
      builder.andWhere(
        '(p.proveedor_ia ILIKE :search OR p.modelo_ia ILIKE :search)',
        { search: `%${escapeLike(query.search)}%` },
      );
    }

    // Sin extremos no hay filtro de fechas: el listado arranca con TODO el
    // historial, que en esta tabla son decenas de filas, no millones.
    if (query.from !== undefined || query.to !== undefined) {
      const range = resolveDateRange(query, PRICING_RANGE_DAYS);
      builder
        .andWhere('p.vigente_desde >= CAST(:from AS timestamptz)', {
          from: range.from.toISOString(),
        })
        .andWhere('p.vigente_desde < CAST(:to AS timestamptz)', {
          to: range.to.toISOString(),
        });
    }

    if (query.activeOnly === true) {
      builder.andWhere('p.activo = true');
    }

    const [rows, total] = await builder
      .take(limit)
      .skip(offset)
      .getManyAndCount();

    return { items: rows.map(toPricingResponse), total, limit, offset };
  }

  /**
   * Registra la tarifa vigente de un par (proveedor, modelo).
   *
   * Relevo ATOMICO: dentro de UNA transaccion se bloquea la vigente
   * (`SELECT ... FOR UPDATE`), se pasa a historico (`activo = false`) y se
   * inserta la nueva con `activo = true`. Si cualquiera de los pasos falla, el
   * `ROLLBACK` deja la vigente intacta: jamas hay un instante con cero o dos
   * tarifas activas para el mismo par.
   *
   * El bloqueo cubre la carrera entre dos ADMIN que ya ven una vigente. La de
   * dos altas simultaneas de un par SIN vigente previa —no hay fila que
   * bloquear— la para el indice unico parcial de la migracion 052, y se
   * traduce a un 409 legible.
   *
   * Auditoria y aviso van DESPUES del `COMMIT`: se anuncia un hecho, nunca una
   * intencion que todavia podia deshacerse.
   *
   * @throws ConflictException Si la tarifa es identica a la vigente, o si otro
   *         ADMIN registro una para el mismo par en el mismo instante.
   */
  public async create(
    dto: CreatePricingDto,
    actorId: string,
    sourceIp: string | null,
  ): Promise<PricingResponseDto> {
    const relay = await this.runRelay(dto, actorId);
    const stored = await this.pricingRepository.findOneOrFail({
      where: { id: relay.created.id },
      relations: AUTHOR_RELATIONS,
    });

    // El interceptor de auditoria registra el CREAR de la fila nueva; el paso
    // a historico de la anterior no pasa por ningun endpoint propio, asi que
    // se audita aqui, explicitamente, como lo que es: una DESACTIVACION.
    if (relay.superseded !== null) {
      await this.auditLogger.record({
        userId: actorId,
        action: AuditActionType.DEACTIVATE,
        affectedTable: AuditTable.PRECIOS_MODELOS_IA,
        recordId: relay.superseded.id,
        previousData: toAuditSnapshot(relay.superseded),
        newData: toAuditSnapshot({ ...relay.superseded, active: false }),
        sourceIp,
      });
    }

    this.pricingEvents.dispatch({
      id: stored.id,
      aiProvider: stored.aiProvider,
      aiModel: stored.aiModel,
      supersededId: relay.superseded?.id ?? null,
      emittedAt: new Date().toISOString(),
    });

    return toPricingResponse(stored);
  }

  /** La transaccion del relevo, aislada para que nada fuera de ella la alargue. */
  private async runRelay(
    dto: CreatePricingDto,
    actorId: string,
  ): Promise<PricingRelay> {
    try {
      return await this.dataSource.transaction(
        async (manager: EntityManager): Promise<PricingRelay> => {
          const repository = manager.getRepository(PrecioModeloIa);

          const current = await repository.findOne({
            where: {
              aiProvider: dto.aiProvider,
              aiModel: dto.aiModel,
              active: true,
            },
            lock: { mode: 'pessimistic_write' },
          });

          if (current !== null && this.isSameTariff(current, dto)) {
            throw new ConflictException(
              'La tarifa indicada es identica a la vigente: no hay nada que registrar.',
            );
          }

          if (current !== null) {
            await repository.update(
              { id: current.id },
              { active: false, updatedByUserId: actorId },
            );
          }

          const created = await repository.save(
            stampCreated(
              repository.create({
                aiProvider: dto.aiProvider,
                aiModel: dto.aiModel,
                promptRateUsdPerMTok: dto.promptRateUsdPerMTok,
                completionRateUsdPerMTok: dto.completionRateUsdPerMTok,
                reasoningRateUsdPerMTok: dto.reasoningRateUsdPerMTok,
                validFrom: new Date(),
                active: true,
              }),
              actorId,
            ),
          );

          return { created, superseded: current };
        },
      );
    } catch (error) {
      if (this.isConcurrentRelay(error)) {
        throw new ConflictException(
          'Otro administrador acaba de registrar una tarifa para este modelo. Recarga la lista y revisa la vigente antes de reintentar.',
        );
      }

      throw error;
    }
  }

  /** Mismas tres tarifas que la vigente: registrarla solo ensuciaria el historial. */
  private isSameTariff(
    current: PrecioModeloIa,
    dto: CreatePricingDto,
  ): boolean {
    return (
      current.promptRateUsdPerMTok === dto.promptRateUsdPerMTok &&
      current.completionRateUsdPerMTok === dto.completionRateUsdPerMTok &&
      current.reasoningRateUsdPerMTok === dto.reasoningRateUsdPerMTok
    );
  }

  /**
   * Choque de unicidad de UNA de las dos restricciones de tarifas. Cualquier
   * otro 23505 sube crudo: disfrazarlo de carrera entre ADMIN mentiria.
   */
  private isConcurrentRelay(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
      return false;
    }

    const driverError = error.driverError as PostgresDriverError | undefined;

    return (
      driverError?.code === PG_UNIQUE_VIOLATION &&
      driverError.constraint !== undefined &&
      PRICING_UNIQUE_CONSTRAINTS.has(driverError.constraint)
    );
  }
}
