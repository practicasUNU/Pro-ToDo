import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In } from 'typeorm';

import { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import { ExecutionState } from '@core/fsm/types/fsm.enums';

import type { FindOptionsSelect, Repository } from 'typeorm';

/** Filtros y ventana de un listado de ejecuciones. */
export interface ExecutionFilter {
  readonly flowId?: string | undefined;
  readonly state?: ExecutionState | undefined;
  readonly limit: number;
  readonly offset: number;
}

/** Pagina de resultados con el total que cumple el filtro, no el de la pagina. */
export interface ExecutionPage {
  readonly items: readonly FsmExecution[];
  readonly total: number;
}

/**
 * Columnas del listado. `contextPayload` queda FUERA a proposito.
 *
 * `contexto_acumulado` es un `jsonb` que acumula lo que publica cada nodo: en un
 * flujo con adjuntos lleva el correo entero en base64, y pesa megabytes. Una
 * pagina de cincuenta filas lo serializaria cincuenta veces para una tabla que
 * solo muestra estado y cursor. El detalle si lo entrega, porque ahi es el dato
 * que se ha pedido.
 */
const SUMMARY_COLUMNS: FindOptionsSelect<FsmExecution> = {
  executionId: true,
  flowId: true,
  currentState: true,
  activeCursor: true,
  logFilePath: true,
  failureReason: true,
  createdAt: true,
  updatedAt: true,
};

/**
 * Lectura de `ejecuciones_flujo`.
 *
 * Vive aparte de `FsmEngineService` por dos motivos. El primero es de tamano:
 * aquel ronda las 1750 lineas y la consulta no comparte nada con el bucle de
 * ejecucion. El segundo es de responsabilidad: el motor es el unico due;o de las
 * ESCRITURAS sobre esta tabla —el checkpoint es suyo y de nadie mas—, pero
 * leerla es una operacion inocua que no tiene por que pasar por el.
 *
 * Se exporta desde `FsmModule` en lugar de exportar el repositorio: asi los
 * modulos de `@modules` consultan ejecuciones sin poder escribirlas.
 */
@Injectable()
export class FsmExecutionQueryService {
  constructor(
    @InjectRepository(FsmExecution)
    private readonly fsmExecutionRepo: Repository<FsmExecution>,
  ) {}

  /**
   * Pagina de ejecuciones, de la mas reciente a la mas antigua.
   *
   * @returns Las filas de la ventana y el total que cumple el filtro.
   */
  public async findPage(filter: ExecutionFilter): Promise<ExecutionPage> {
    const where: {
      flowId?: string;
      currentState?: ExecutionState;
    } = {};

    if (filter.flowId !== undefined) {
      where.flowId = filter.flowId;
    }

    if (filter.state !== undefined) {
      where.currentState = filter.state;
    }

    const [items, total] = await this.fsmExecutionRepo.findAndCount({
      where,
      select: SUMMARY_COLUMNS,
      // Por fecha de inicio y no de actualizacion: el operador busca "la
      // ejecucion de esta manana", y `fecha_actualizacion` reordenaria la lista
      // cada vez que un checkpoint toca una fila antigua.
      order: { createdAt: 'DESC' },
      take: filter.limit,
      skip: filter.offset,
    });

    return { items, total };
  }

  /** Ejecucion completa, con el contexto acumulado. `null` si no existe. */
  public async findById(executionId: string): Promise<FsmExecution | null> {
    return this.fsmExecutionRepo.findOne({ where: { executionId } });
  }

  /**
   * Ejecuciones de un flujo que todavia no han terminado.
   *
   * VIVA es EN_PROCESO o PAUSADO: la primera tiene un bucle atendiendola y la
   * segunda espera un reintento manual (CU-09). Las dos impiden que el flujo
   * arranque otra, asi que para quien pregunta «puedo despachar?» cuentan igual.
   */
  public async findLiveByFlow(flowId: string): Promise<FsmExecution[]> {
    return this.fsmExecutionRepo.find({
      where: {
        flowId,
        currentState: In([ExecutionState.EN_PROCESO, ExecutionState.PAUSADO]),
      },
      select: SUMMARY_COLUMNS,
      order: { createdAt: 'DESC' },
    });
  }
}
