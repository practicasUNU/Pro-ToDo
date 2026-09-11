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

  /**
   * Tipos que tienen estrategia registrada AHORA MISMO.
   *
   * Existe para que el catalogo de nodos (`GET /api/nodos`) no prometa mas de lo
   * que el motor sabe ejecutar. Antes esa marca se derivaba del enum `NodeType`,
   * que declara ocho tipos mientras que solo tres estan implementados: el
   * asistente dejaba elegir nodos que despues reventaban con
   * `StrategyNotFoundException`. Esta es la unica fuente de verdad real.
   *
   * Devuelve un `Set` NUEVO en cada llamada y no una vista del interno: con un
   * `ReadonlyMap` bastaria un cast para recuperar la referencia mutable, y quien
   * consulta este metodo es un lector que no debe poder alterar el registro.
   *
   * Quien lo consuma debe llamarlo EN CADA USO y no cachear el resultado al
   * construirse: los providers se instancian antes de los `onModuleInit`, que es
   * justo donde se registran las estrategias, asi que un valor capturado en un
   * constructor seria siempre el conjunto vacio.
   */
  public getRegisteredNodeTypes(): ReadonlySet<NodeType> {
    return new Set(this.strategies.keys());
  }
}
