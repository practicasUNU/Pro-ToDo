import { NodeType } from '@core/fsm/types/pipeline-schema.types';

import { NodeCatalogEntry } from '../entities/node-catalog.entity';
import { NodeCategory } from '../enums/node-category.enum';
import { NodeCatalogService } from './node-catalog.service';

import type { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
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

/**
 * Estrategias registradas por defecto: las tres que el modulo inscribe hoy.
 *
 * Se declaran aqui y no se derivan de `NodeType` a proposito: derivarlas
 * reproduciria en la prueba el mismo error que este servicio acaba de dejar de
 * cometer —dar por implementado todo lo que el enum declara—.
 */
const REGISTERED_TYPES: readonly NodeType[] = [
  NodeType.TRIGGER_IMAP,
  NodeType.TRIGGER_CRON,
  NodeType.MAPEADOR_PLANTILLA,
];

/** Doble de la factoria que solo responde al listado de tipos registrados. */
const buildFactory = (
  registered: readonly NodeType[] = REGISTERED_TYPES,
): NodeStrategyFactory =>
  ({
    getRegisteredNodeTypes: jest.fn(() => new Set(registered)),
  }) as unknown as NodeStrategyFactory;

const buildService = (
  repository: CatalogRepositoryMock,
  factory: NodeStrategyFactory = buildFactory(),
): NodeCatalogService =>
  new NodeCatalogService(
    repository as unknown as Repository<NodeCatalogEntry>,
    factory,
  );

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

    // Dos familias distintas de "sin estrategia", y las dos deben salir en
    // `false`: `DESTINO_ACENS` ni siquiera esta en el enum, mientras que
    // `PROCESADOR_IA` y compania SI lo estan pero nadie las ha registrado en la
    // factoria. Esta segunda familia es la que antes se marcaba como
    // implementada y dejaba al asistente elegir nodos que reventaban al
    // ejecutarse.
    it.each([
      'DESTINO_ACENS',
      NodeType.PROCESADOR_IA,
      NodeType.EXTRACTOR_WEB,
      NodeType.DESTINO_HTTP,
    ])(
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
        buildEntry({ code: 'DESTINO_ACENS' }),
      ]);
      const service = buildService(repository);

      // 2. Act
      const result = await service.findAll();

      // 3. Assert: el endpoint describe el catalogo; ocultar filas lo haria mentir
      expect(result).toHaveLength(2);
      expect(result.map((entry) => entry.implemented)).toEqual([true, false]);
    });

    it('2.4 deberia seguir a la factoria y no al enum de tipos', async () => {
      // 1. Arrange: `TRIGGER_CRON` esta en el enum, pero en este escenario nadie
      //    registro su estrategia. La marca tiene que reflejar lo que el motor
      //    sabe ejecutar, no lo que el enum declara.
      const repository = buildRepository([
        buildEntry({ code: NodeType.TRIGGER_CRON }),
      ]);
      const service = buildService(repository, buildFactory([]));

      // 2. Act
      const [entry] = await service.findAll();

      // 3. Assert
      expect(entry?.implemented).toBe(false);
    });

    it('2.5 deberia consultar la factoria en cada llamada y no cachearla', async () => {
      // 1. Arrange: los providers se instancian ANTES de los `onModuleInit`, que
      //    es donde se registran las estrategias. Si el servicio guardase el
      //    conjunto al construirse, el catalogo entero saldria sin implementar.
      const repository = buildRepository([
        buildEntry({ code: NodeType.TRIGGER_CRON }),
      ]);
      const registered: NodeType[] = [];
      const factory = {
        getRegisteredNodeTypes: jest.fn(() => new Set(registered)),
      } as unknown as NodeStrategyFactory;
      const service = buildService(repository, factory);

      // 2. Act: primera lectura sin estrategias, segunda ya con la registrada.
      const [before] = await service.findAll();
      registered.push(NodeType.TRIGGER_CRON);
      const [after] = await service.findAll();

      // 3. Assert
      expect(before?.implemented).toBe(false);
      expect(after?.implemented).toBe(true);
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
