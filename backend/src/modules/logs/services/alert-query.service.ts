import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { AlertaError } from '@modules/logs/entities/alerta-error.entity';

/**
 * Lecturas de `alertas_error` para otros modulos.
 *
 * Se exporta este servicio y no el repositorio: quien lista ejecuciones solo
 * necesita saber CUALES tienen alertas, no poder escribir en la tabla.
 */
@Injectable()
export class AlertQueryService {
  constructor(
    @InjectRepository(AlertaError)
    private readonly alertRepository: Repository<AlertaError>,
  ) {}

  /**
   * Ejecuciones de la lista que registraron al menos una alerta, resuelta o no.
   *
   * Una sola consulta por pagina del listado (`DISTINCT` sobre
   * `idx_alertas_error_id_ejecucion`), nunca una por fila. Las resueltas
   * cuentan: el visor de logs tambien sirve para auditar despues.
   */
  public async findExecutionIdsWithAlerts(
    executionIds: readonly string[],
  ): Promise<Set<string>> {
    if (executionIds.length === 0) return new Set();

    const rows = await this.alertRepository
      .createQueryBuilder('a')
      .select('DISTINCT a.id_ejecucion', 'executionId')
      .where({ executionId: In([...executionIds]) })
      .getRawMany<{ executionId: string }>();

    return new Set(rows.map((row) => row.executionId));
  }
}
