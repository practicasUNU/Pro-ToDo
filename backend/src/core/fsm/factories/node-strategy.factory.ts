import { Injectable, Logger } from '@nestjs/common';

import { StrategyNotFoundException } from '@core/fsm/exceptions/strategy-not-found.exception';

import type { INodeStrategy } from '@core/fsm/types/node-strategy.types';
import type { NodeType } from '@core/fsm/types/pipeline-schema.types';

/**
 * Resolucion polimorfica de estrategias por tipo de nodo.
 *
 * El motor no conoce ninguna estrategia concreta: pide la que corresponde al
 * `nodeType` del paso activo y ejecuta lo que reciba. Anadir un tipo de nodo no
 * obliga a tocar `FsmEngineService`.
 *
 * El registro es explicito (`registerStrategy`) y no por descubrimiento
 * automatico: una estrategia solo entra en juego si alguien la declara, lo que
 * evita que un archivo suelto en `src/strategies/` se active sin querer.
 */
@Injectable()
export class NodeStrategyFactory {
  private readonly logger = new Logger(NodeStrategyFactory.name);
  private readonly strategies = new Map<NodeType, INodeStrategy>();

  /**
   * Asocia una estrategia a su `nodeType`.
   *
   * Registrar dos veces el mismo tipo sustituye a la anterior y deja aviso: es
   * casi siempre un error de cableado, pero no debe impedir el arranque.
   */
  public registerStrategy(strategy: INodeStrategy): void {
    if (this.strategies.has(strategy.nodeType)) {
      this.logger.warn(
        `La estrategia para "${strategy.nodeType}" ya estaba registrada y se sustituye.`,
      );
    }

    this.strategies.set(strategy.nodeType, strategy);
    this.logger.log(
      `Estrategia registrada para el nodo "${strategy.nodeType}".`,
    );
  }

  /**
   * Devuelve la estrategia del tipo indicado.
   *
   * @throws StrategyNotFoundException Si no hay ninguna registrada.
   */
  public getStrategy(nodeType: NodeType): INodeStrategy {
    const strategy = this.strategies.get(nodeType);

    if (strategy === undefined) {
      this.logger.error(
        `Sin estrategia para "${nodeType}". Registradas: [${[...this.strategies.keys()].join(', ')}].`,
      );
      throw new StrategyNotFoundException(nodeType);
    }

    return strategy;
  }
}
