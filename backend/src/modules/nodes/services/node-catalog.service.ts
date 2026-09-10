import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { NodeCatalogResponseDto } from '@modules/nodes/dto/node-catalog-response.dto';
import { NodeCatalogEntry } from '@modules/nodes/entities/node-catalog.entity';

/**
 * Codigos que el motor sabe ejecutar de verdad, resueltos UNA vez.
 *
 * `NodeType` es la autoridad, no el catalogo: la tabla `nodos` conserva filas
 * historicas (`TRIGGER_CRON`, `DESTINO_ACENS`) que no tienen `INodeStrategy` y
 * que `@IsEnum(NodeType)` rechazaria si alguien las metiese en un esquema.
 */
const IMPLEMENTED_CODES: ReadonlySet<string> = new Set<string>(
  Object.values(NodeType),
);

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
   */
  public async findAll(): Promise<NodeCatalogResponseDto[]> {
    const entries = await this.catalogRepository.find({
      order: { category: 'ASC', name: 'ASC' },
    });

    return entries.map((entry) => this.toResponse(entry));
  }

  private toResponse(entry: NodeCatalogEntry): NodeCatalogResponseDto {
    return {
      id: entry.id,
      code: entry.code,
      name: entry.name,
      category: entry.category,
      description: entry.description,
      uiSchema: entry.uiSchema,
      implemented: IMPLEMENTED_CODES.has(entry.code),
    };
  }
}
