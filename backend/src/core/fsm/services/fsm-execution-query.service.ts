import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Raw } from 'typeorm';

import { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import { ExecutionState } from '@core/fsm/types/fsm.enums';

import type { DateRange } from '@common/utils/date-range.util';
import type { ResolvedSort } from '@common/utils/sort-whitelist.util';
import type { FindOptionsOrder, FindOptionsSelect, Repository } from 'typeorm';

/** Filtros y ventana de un listado de ejecuciones. */
export interface ExecutionFilter {
  readonly flowId?: string | undefined;
  readonly state?: ExecutionState | undefined;
  /** Rango semiabierto `[from, to)` sobre la fecha de inicio. */
  readonly startedBetween?: DateRange | undefined;
  readonly limit: number;
  readonly offset: number;
  /**
   * Orden ya resuelto contra la lista blanca (`EXECUTION_SORT_COLUMNS`): la
   * columna es SIEMPRE una propiedad de `FsmExecution` escrita en el codigo,
   * nunca texto del cliente. Sin el, el de siempre: alta mas reciente primero.
   */
  readonly sort?: ResolvedSort | undefined;
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
   * Pagina de ejecuciones, por defecto de la mas reciente a la mas antigua.
   *
   * @returns Las filas de la ventana y el total que cumple el filtro.
   */
  public async findPage(filter: ExecutionFilter): Promise<ExecutionPage> {
    const where: {
      flowId?: string;
      currentState?: ExecutionState;
      createdAt?: ReturnType<typeof Raw>;
    } = {};

    if (filter.flowId !== undefined) {
      where.flowId = filter.flowId;
    }

    if (filter.state !== undefined) {
      where.currentState = filter.state;
    }

    if (filter.startedBetween !== undefined) {
      // CAST a `timestamptz` y limites en ISO: `fecha_inicio` es TIMESTAMP SIN
      // zona, y un `Date` a secas se compararia en la zona del proceso de Node
      // y desplazaria el rango horas (mismo criterio que la telemetria).
      where.createdAt = Raw(
        (column) =>
          `${column} >= CAST(:startedFrom AS timestamptz) AND ${column} < CAST(:startedTo AS timestamptz)`,
        {
          startedFrom: filter.startedBetween.from.toISOString(),
          startedTo: filter.startedBetween.to.toISOString(),
        },
      );
    }

    // Por defecto, fecha de inicio y no de actualizacion: el operador busca
    // "la ejecucion de esta manana", y `fecha_actualizacion` reordenaria la
    // lista cada vez que un checkpoint toca una fila antigua. El id desempata
    // para que dos filas con el mismo valor no bailen entre paginas.
    const sort = filter.sort ?? { column: 'createdAt', order: 'DESC' };
    const order = {
      [sort.column]: sort.order,
      executionId: sort.order,
    } as FindOptionsOrder<FsmExecution>;

    const [items, total] = await this.fsmExecutionRepo.findAndCount({
      where,
      select: SUMMARY_COLUMNS,
      order,
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
  /**
   * Ejecuciones vivas de VARIOS flujos, en una sola consulta.
   *
   * Hermano de `findLiveByFlow`: mismo filtro y mismas columnas, pero para el
   * listado del catalogo, donde una llamada por flujo seria un N+1 sobre una
   * tabla que crece con cada disparo del sondeo.
   *
   * El singular se conserva porque `assertNotInFlight` pregunta por UN flujo, y
   * reexpresarlo sobre el plural le haria construir un arreglo para nada.
   */
  public async findLiveByFlows(
    flowIds: readonly string[],
  ): Promise<FsmExecution[]> {
    // `In([])` genera un `IN ()` que PostgreSQL rechaza, y un catalogo vacio no
    // necesita ninguna consulta.
    if (flowIds.length === 0) {
      return [];
    }

    return this.fsmExecutionRepo.find({
      where: {
        flowId: In([...flowIds]),
        currentState: In([ExecutionState.EN_PROCESO, ExecutionState.PAUSADO]),
      },
      select: SUMMARY_COLUMNS,
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Todas las ejecuciones detenidas, CON su contexto acumulado.
   *
   * Es el unico metodo de esta clase que no usa `SUMMARY_COLUMNS`, y la
   * excepcion esta acotada a proposito: el contexto puede llevar el correo
   * entrante en base64, asi que traerlo en los listados multiplicaria por mil
   * el peso de una pantalla. Aqui hace falta porque la reanudacion por correo
   * identifica la ejecucion por un testigo que vive dentro de ese contexto, y
   * no hay columna por la que filtrar sin inventarse una.
   *
   * El conjunto que devuelve es naturalmente pequeno —una ejecucion detenida
   * es una que reclama atencion humana— y se recorre en memoria.
   */
  public async findPausedWithContext(): Promise<FsmExecution[]> {
    return this.fsmExecutionRepo.find({
      where: { currentState: ExecutionState.PAUSADO },
      order: { createdAt: 'DESC' },
    });
  }

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
