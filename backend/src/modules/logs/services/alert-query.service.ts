import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { AlertaError } from '@modules/logs/entities/alerta-error.entity';
import { LogNodo, NodeLogStatus } from '@modules/logs/entities/log-nodo.entity';

/**
 * Lecturas de `alertas_error` y `logs_nodo` para otros modulos.
 *
 * Se exporta este servicio y no los repositorios: quien lista ejecuciones solo
 * necesita saber CUALES tienen alertas, y quien reanuda por correo solo
 * necesita el ultimo codigo de error de un nodo; ninguno debe poder escribir
 * en las tablas de trazabilidad.
 */
@Injectable()
export class AlertQueryService {
  constructor(
    @InjectRepository(AlertaError)
    private readonly alertRepository: Repository<AlertaError>,
    @InjectRepository(LogNodo)
    private readonly nodeLogRepository: Repository<LogNodo>,
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

  /**
   * Codigo de error del ultimo DESENLACE de un nodo, si fue un fallo.
   *
   * Lo usa la reanudacion por correo para no volver a ejecutar un
   * `ESCUDO_POST_IA` contra la misma respuesta de la IA que ya rechazo: el
   * codigo no vive en la ejecucion, sino en la traza del nodo.
   *
   * Solo cuentan `OK` y `ERROR`. Las filas `ADVERTENCIA` del nodo son, entre
   * otras, la marca que `ExecutionsService` escribe en cada reanudacion, y no
   * dicen nada de como acabo el nodo. Mirar el ultimo desenlace y no el ultimo
   * error evita tratar como bucle a un escudo que fallo y despues paso.
   *
   * `null` si el nodo nunca termino, si su ultimo desenlace fue `OK` o si el
   * fallo no llevaba codigo.
   */
  public async findLastNodeErrorCode(
    executionId: string,
    nodeId: string,
  ): Promise<string | null> {
    const lastOutcome = await this.nodeLogRepository.findOne({
      where: {
        executionId,
        nodeId,
        status: In([NodeLogStatus.OK, NodeLogStatus.ERROR]),
      },
      order: { createdAt: 'DESC' },
      select: { id: true, status: true, errorCode: true },
    });

    return lastOutcome?.status === NodeLogStatus.ERROR
      ? lastOutcome.errorCode
      : null;
  }
}
