import { NodeType } from '@core/fsm/types/pipeline-schema.types';

import { NodeCatalogEntry } from '../entities/node-catalog.entity';
import { NodeCategory } from '../enums/node-category.enum';
import { NodeCatalogService } from './node-catalog.service';

import type { Repository } from 'typeorm';

type CatalogRepositoryMock = jest.Mocked<
  Pick<Repository<NodeCatalogEntry>, 'find'>
>;

/** Fila del catalogo; los campos que no se aseveran quedan en valores neutros. */
const buildEntry = (
  overrides: Partial<NodeCatalogEntry> = {},
): NodeCatalogEntry => ({
  id: '5e2d1c4b-7a89-4f30-b1c2-6d5e4f3a2b10',
  code: NodeType.TRIGGER_IMAP,
  name: 'Disparador IMAP',
  category: NodeCategory.TRIGGER,
  description: 'Inicia el flujo mediante la lectura de correos entrantes',
  uiSchema: {},
  ...overrides,
});

const buildService = (repository: CatalogRepositoryMock): NodeCatalogService =>
  new NodeCatalogService(repository as unknown as Repository<NodeCatalogEntry>);

const buildRepository = (
  entries: NodeCatalogEntry[],
): CatalogRepositoryMock => ({
  find: jest.fn<Promise<NodeCatalogEntry[]>, []>().mockResolvedValue(entries),
});

describe('NodeCatalogService · lectura del catalogo de tipos de nodo', () => {
  describe('1. Orden del listado', () => {
    it('1.1 deberia pedir el catalogo ordenado por categoria y luego por nombre', async () => {
      // 1. Arrange
      const repository = buildRepository([]);
      const service = buildService(repository);

      // 2. Act
      await service.findAll();

      // 3. Assert: reproduce la agrupacion del selector sin que ordene el cliente
      expect(repository.find).toHaveBeenCalledWith({
        order: { category: 'ASC', name: 'ASC' },
      });
    });
  });

  describe('2. Marca de tipos ejecutables', () => {
    it('2.1 deberia marcar implemented en true para un tipo con estrategia', async () => {
      // 1. Arrange
      const repository = buildRepository([
        buildEntry({ code: NodeType.MAPEADOR_PLANTILLA }),
      ]);
      const service = buildService(repository);

      // 2. Act
      const [entry] = await service.findAll();

      // 3. Assert
      expect(entry?.implemented).toBe(true);
    });

    // `TRIGGER_CRON` y `DESTINO_ACENS` siguen en la tabla desde el seed original
    // pero no estan en el enum: un pipeline_schema que los declare es rechazado
    // por `@IsEnum(NodeType)`, asi que el selector debe deshabilitarlos.
    it.each(['TRIGGER_CRON', 'DESTINO_ACENS'])(
      '2.2 deberia marcar implemented en false para %s, que no tiene estrategia',
      async (code: string) => {
        // 1. Arrange
        const repository = buildRepository([buildEntry({ code })]);
        const service = buildService(repository);

        // 2. Act
        const [entry] = await service.findAll();

        // 3. Assert
        expect(entry?.implemented).toBe(false);
      },
    );

    it('2.3 NO deberia filtrar los tipos sin estrategia', async () => {
      // 1. Arrange
      const repository = buildRepository([
        buildEntry({ code: NodeType.TRIGGER_IMAP }),
        buildEntry({ code: 'TRIGGER_CRON' }),
      ]);
      const service = buildService(repository);

      // 2. Act
      const result = await service.findAll();

      // 3. Assert: el endpoint describe el catalogo; ocultar filas lo haria mentir
      expect(result).toHaveLength(2);
      expect(result.map((entry) => entry.implemented)).toEqual([true, false]);
    });
  });

  describe('3. Proyeccion', () => {
    it('3.1 deberia propagar los campos del catalogo tal cual', async () => {
      // 1. Arrange
      const entry = buildEntry({
        description: null,
        uiSchema: { fields: ['mailbox'] },
      });
      const repository = buildRepository([entry]);
      const service = buildService(repository);

      // 2. Act
      const [result] = await service.findAll();

      // 3. Assert
      expect(result).toEqual({
        id: entry.id,
        code: entry.code,
        name: entry.name,
        category: NodeCategory.TRIGGER,
        description: null,
        uiSchema: { fields: ['mailbox'] },
        implemented: true,
      });
    });
  });
});
