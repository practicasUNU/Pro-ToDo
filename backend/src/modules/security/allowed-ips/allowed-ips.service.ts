import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import ipRangeCheck from 'ip-range-check';
import { Repository } from 'typeorm';

import { CrudEventsCoordinator } from '@common/services/crud-events.coordinator';
import {
  AUDIT_RELATIONS,
  stampCreated,
  stampUpdated,
} from '@common/utils/audit.util';
import {
  ALLOWED_IP_RANGES_ENV,
  ALLOWED_IPS_CACHE_TTL_MS,
  DEFAULT_LOCALHOST_RANGES,
} from '@common/constants/security.constants';

import { toAllowedIpResponse } from './dto/allowed-ip-response.dto';
import { CreateAllowedIpDto } from './dto/create-allowed-ip.dto';
import { UpdateAllowedIpDto } from './dto/update-allowed-ip.dto';
import { AllowedIp } from './entities/allowed-ip.entity';

import type { CrudAction } from '@common/types/crud-events.types';

interface RangesCache {
  ranges: string[];
  expiresAt: number;
}

/**
 * Fuente de verdad de los rangos CIDR/IP autorizados (PROT-05), respaldada en
 * PostgreSQL. `IpAccessService` delega aqui en lugar de leer `ALLOWED_IP_RANGES`
 * directamente, para que el perimetro se pueda administrar en caliente.
 */
@Injectable()
export class AllowedIpsService {
  private cache: RangesCache | null = null;

  constructor(
    @InjectRepository(AllowedIp)
    private readonly allowedIpRepository: Repository<AllowedIp>,
    private readonly configService: ConfigService,
    private readonly crudEvents: CrudEventsCoordinator,
  ) {}

  public async findAll(): Promise<AllowedIp[]> {
    return this.allowedIpRepository.find({
      relations: AUDIT_RELATIONS,
      order: { createdAt: 'ASC' },
    });
  }

  public async findById(id: string): Promise<AllowedIp> {
    const entry = await this.allowedIpRepository.findOne({
      where: { id },
      relations: AUDIT_RELATIONS,
    });

    if (!entry) {
      throw new NotFoundException(`IP autorizada con id "${id}" no encontrada`);
    }

    return entry;
  }

  /**
   * Difunde la mutacion a los paneles abiertos.
   *
   * Se invoca en los TRES puntos de llamada y no dentro de `invalidateCache`,
   * que no recibe argumentos: meterla ahi obligaria a cambiarle la firma y
   * convertiria un invalidador de cache en un emisor de eventos.
   */
  private publishMutation(
    action: CrudAction,
    id: string,
    entry?: AllowedIp,
  ): void {
    this.crudEvents.dispatch({
      entity: 'allowed_ips',
      action,
      id,
      ...(entry !== undefined ? { data: toAllowedIpResponse(entry) } : {}),
      emittedAt: new Date().toISOString(),
    });
  }

  public async create(
    createAllowedIpDto: CreateAllowedIpDto,
    actorId: string,
  ): Promise<AllowedIp> {
    const ipOrCidr = createAllowedIpDto.ipOrCidr.trim();

    await this.assertNotDuplicate(ipOrCidr);

    const entry = this.allowedIpRepository.create({
      ipOrCidr,
      description: createAllowedIpDto.description.trim(),
    });
    const saved = await this.allowedIpRepository.save(
      stampCreated(entry, actorId),
    );
    // Se relee para devolver los autores ya resueltos (`AUDIT_RELATIONS`).
    const stored = await this.findById(saved.id);

    this.invalidateCache();
    this.publishMutation('CREATED', stored.id, stored);

    return stored;
  }

  public async update(
    id: string,
    updateAllowedIpDto: UpdateAllowedIpDto,
    actorId: string,
  ): Promise<AllowedIp> {
    const entry = await this.findById(id);

    if (updateAllowedIpDto.ipOrCidr !== undefined) {
      const ipOrCidr = updateAllowedIpDto.ipOrCidr.trim();
      await this.assertNotDuplicate(ipOrCidr, id);
      entry.ipOrCidr = ipOrCidr;
    }

    if (updateAllowedIpDto.description !== undefined) {
      entry.description = updateAllowedIpDto.description.trim();
    }

    await this.allowedIpRepository.save(stampUpdated(entry, actorId));
    const stored = await this.findById(id);

    this.invalidateCache();
    this.publishMutation('UPDATED', stored.id, stored);

    return stored;
  }

  // Borrado fisico: a diferencia de los usuarios, una IP retirada no debe seguir
  // vigente ni aparecer en el listado administrativo.
  public async remove(id: string): Promise<AllowedIp> {
    const entry = await this.findById(id);

    // `remove` desprende la entidad, de modo que hay que quedarse con el id
    // ANTES de perderlo: es lo unico que el panel necesita para sacar la fila.
    const removedId = entry.id;

    await this.allowedIpRepository.remove(entry);

    this.invalidateCache();
    // Unico `DELETED` del sistema: aqui la fila desaparece de verdad, asi que
    // no viaja `data` —no queda nada que describir.
    this.publishMutation('DELETED', removedId);

    return entry;
  }

  /**
   * Verifica si `clientIp` cae dentro de algun rango autorizado (localhost,
   * `ALLOWED_IP_RANGES` o la tabla). Unico metodo que consume `IpAccessService`.
   */
  public async isIpAllowed(clientIp: string): Promise<boolean> {
    const ranges = await this.getAllowedRanges();
    return ipRangeCheck(clientIp, ranges);
  }

  private async assertNotDuplicate(
    ipOrCidr: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.allowedIpRepository.findOne({
      where: { ipOrCidr },
    });

    if (existing && existing.id !== excludeId) {
      throw new ConflictException(
        `La IP o rango "${ipOrCidr}" ya esta registrado`,
      );
    }
  }

  /**
   * Rangos vigentes, con cache en memoria de `ALLOWED_IPS_CACHE_TTL_MS` para no
   * consultar la tabla en cada peticion. Se invalida de inmediato ante cualquier
   * mutacion (`create`/`update`/`remove`) y expira sola si la tabla cambia por
   * otra via (ej. SQL directo).
   *
   * Union SIEMPRE vigente de tres fuentes, nunca "la tabla o el fallback":
   * localhost (`DEFAULT_LOCALHOST_RANGES`), `ALLOWED_IP_RANGES` y las filas de
   * la tabla. Que un admin registre una IP ajena no puede excluir al propio
   * acceso local ni a los rangos de infraestructura del `.env` — de lo
   * contrario, un alta incompleta bloquearia al administrador a si mismo sin
   * mas via de recuperacion que tocar la base de datos a mano.
   */
  private async getAllowedRanges(): Promise<string[]> {
    const now = Date.now();

    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.ranges;
    }

    const entries = await this.allowedIpRepository.find();
    const ranges = [
      ...DEFAULT_LOCALHOST_RANGES,
      ...this.getEnvRanges(),
      ...entries.map((entry) => entry.ipOrCidr),
    ];

    this.cache = { ranges, expiresAt: now + ALLOWED_IPS_CACHE_TTL_MS };
    return ranges;
  }

  private getEnvRanges(): string[] {
    return (this.configService.get<string>(ALLOWED_IP_RANGES_ENV) ?? '')
      .split(',')
      .map((range) => range.trim())
      .filter(Boolean);
  }

  private invalidateCache(): void {
    this.cache = null;
  }
}
