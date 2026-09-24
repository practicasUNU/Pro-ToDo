import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

// Import de VALOR: `NodeStrategyFactory` se inyecta por constructor, y con
// `emitDecoratorMetadata` un `import type` se borra al transpilar dejando a Nest
// sin el token que necesita para resolver la dependencia.
import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import { NodeCatalogResponseDto } from '@modules/nodes/dto/node-catalog-response.dto';
import { NodeCatalogEntry } from '@modules/nodes/entities/node-catalog.entity';

import type { NodeOutputField } from '@core/fsm/types/node-strategy.types';
import type { NodeType } from '@core/fsm/types/pipeline-schema.types';

/**
 * Lectura del catalogo de tipos de nodo (PROT-07).
 *
 * Solo lectura a proposito: las filas son datos de instalacion, sembrados por
 * `init.sql` y alineados por las migraciones. Un alta por API crearia un tipo
 * sin estrategia que lo ejecute, es decir, un flujo que el motor no sabria
 * recorrer.
 */
@Injectable()
export class NodeCatalogService {
  constructor(
    @InjectRepository(NodeCatalogEntry)
    private readonly catalogRepository: Repository<NodeCatalogEntry>,
    private readonly strategyFactory: NodeStrategyFactory,
  ) {}

  /**
   * Catalogo completo, marcado con `implemented`.
   *
   * NO se filtran los tipos sin estrategia: el endpoint describe el catalogo y
   * ocultar filas lo haria mentir sobre su contenido. Se devuelven marcados para
   * que el selector los deshabilite —que es Poka-Yoke honesto: el operador ve
   * que el tipo existe y que todavia no se puede usar.
   *
   * Orden por categoria y luego por nombre: reproduce la agrupacion del selector
   * (disparador, procesamiento, control, destino) sin que el cliente ordene.
   *
   * El conjunto de tipos ejecutables se pide a la factoria AQUI, en cada
   * peticion, y no se guarda en un campo al construirse: los providers se
   * instancian antes de que `NodesModule.onModuleInit` registre las estrategias,
   * asi que un valor capturado en el constructor seria siempre vacio y todo el
   * catalogo saldria como no implementado.
   */
  public async findAll(): Promise<NodeCatalogResponseDto[]> {
    const entries = await this.catalogRepository.find({
      order: { category: 'ASC', name: 'ASC' },
    });

    const registered = this.strategyFactory.getRegisteredNodeTypes();

    return entries.map((entry) => this.toResponse(entry, registered));
  }

  private toResponse(
    entry: NodeCatalogEntry,
    registered: ReadonlySet<NodeType>,
  ): NodeCatalogResponseDto {
    return {
      id: entry.id,
      code: entry.code,
      name: entry.name,
      category: entry.category,
      description: entry.description,
      uiSchema: entry.uiSchema,
      // El `code` de la tabla es `string` y no `NodeType` porque el catalogo
      // tiene filas que el enum no declara; el `has` sobre un valor ajeno al
      // conjunto simplemente devuelve false, que es exactamente lo que se quiere.
      implemented: registered.has(entry.code as NodeType),
      outputFields: this.resolveOutputFields(entry.code),
    };
  }

  /**
   * Campos de salida que declara la estrategia del tipo, o vacio si no hay.
   *
   * Se pide a la factoria EN CADA PETICION, por el mismo motivo que
   * `getRegisteredNodeTypes` en `findAll`: las estrategias se registran en el
   * `onModuleInit` de `NodesModule`, despues de que este provider se construya.
   *
   * Los dos caminos a vacio —tipo sin estrategia y estrategia que no declara sus
   * campos— se funden a proposito en el mismo `[]`: para el selector del
   * asistente son el mismo hecho, que es que no hay nada que ofrecer. El caso
   * "no tiene estrategia" ya lo distingue `implemented`.
   */
  private resolveOutputFields(code: string): readonly NodeOutputField[] {
    try {
      return (
        this.strategyFactory.getStrategy(code as NodeType).outputFields ?? []
      );
    } catch {
      return [];
    }
  }
}
