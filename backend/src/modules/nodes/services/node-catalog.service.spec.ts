import { NodeType } from '@core/fsm/types/pipeline-schema.types';

import { NodeCatalogEntry } from '../entities/node-catalog.entity';
import { NodeCategory } from '../enums/node-category.enum';
import { NodeCatalogService } from './node-catalog.service';

import type { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import type { NodeOutputField } from '@core/fsm/types/node-strategy.types';
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
  ...overrides,
});

/**
 * Estrategias registradas por defecto: las que `NodesModule` inscribe hoy.
 *
 * Se declaran aqui y no se derivan de `NodeType` a proposito: derivarlas
 * reproduciria en la prueba el mismo error que este servicio acaba de dejar de
 * cometer —dar por implementado todo lo que el enum declara—.
 */
const REGISTERED_TYPES: readonly NodeType[] = [
  NodeType.TRIGGER_IMAP,
  NodeType.TRIGGER_CRON,
  NodeType.PARSER_PRE_IA,
  NodeType.EXTRACTOR_WEB,
  NodeType.MAPEADOR_PLANTILLA,
];

/**
 * Doble de la factoria: listado de tipos registrados y resolucion de estrategia.
 *
 * `getStrategy` LANZA para un tipo no registrado, igual que la factoria real:
 * es esa excepcion la que el servicio engulle para devolver `[]`, y un doble que
 * devolviera `undefined` no probaria ese camino.
 */
const buildFactory = (
  registered: readonly NodeType[] = REGISTERED_TYPES,
  outputFieldsByType: Partial<
    Record<NodeType, readonly NodeOutputField[]>
  > = {},
): NodeStrategyFactory =>
  ({
    getRegisteredNodeTypes: jest.fn(() => new Set(registered)),
    getStrategy: jest.fn((nodeType: NodeType) => {
      if (!registered.includes(nodeType)) {
        throw new Error(`Sin estrategia para ${nodeType}`);
      }

      const outputFields = outputFieldsByType[nodeType];

      return outputFields === undefined ? {} : { outputFields };
    }),
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
    // `false`: `DESTINO_LEGADO` (fila ficticia) ni siquiera esta en el enum, mientras que
    // `PROCESADOR_IA` y `DESTINO_DRUPAL` SI lo estan y en produccion YA tienen
    // estrategia registrada (`LlmExtractorStrategy` y `DrupalHttpStrategy`),
    // pero aqui la factoria doble no las inscribe: `REGISTERED_TYPES` es un
    // conjunto reducido a proposito. Esa es justo la propiedad bajo prueba —la
    // marca sigue a la factoria, no al enum ni a lo que hoy este implementado—,
    // y es la que antes se incumplia dejando al asistente elegir nodos que
    // reventaban al ejecutarse.
    it.each([
      'DESTINO_LEGADO',
      NodeType.PROCESADOR_IA,
      NodeType.DESTINO_DRUPAL,
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
        buildEntry({ code: 'DESTINO_LEGADO' }),
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
        getStrategy: jest.fn(() => ({})),
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
      const entry = buildEntry({ description: null });
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
        implemented: true,
        outputFields: [],
      });
    });

    it('3.2 deberia exponer los campos de salida que declara la estrategia', async () => {
      // 1. Arrange
      const fields: readonly NodeOutputField[] = [
        { name: 'extracted_urls', type: 'url[]' },
        { name: 'clean_body', type: 'text' },
      ];
      const entry = buildEntry({
        code: NodeType.PARSER_PRE_IA,
        name: 'Parser pre-IA',
      });
      const repository = buildRepository([entry]);
      const service = buildService(
        repository,
        buildFactory(REGISTERED_TYPES, { [NodeType.PARSER_PRE_IA]: fields }),
      );

      // 2. Act
      const [result] = await service.findAll();

      // 3. Assert: es el inventario que alimenta el selector de interpolaciones
      expect(result?.outputFields).toEqual(fields);
    });

    it('3.3 deberia devolver campos vacios para un tipo sin estrategia registrada', async () => {
      // 1. Arrange: una fila de catalogo sin estrategia (ficticia: desde la
      // migracion 066 todas las filas reales tienen la suya)
      const entry = buildEntry({
        code: 'DESTINO_LEGADO',
        name: 'Destino legado',
        category: NodeCategory.DESTINO,
      });
      const repository = buildRepository([entry]);
      const service = buildService(repository);

      // 2. Act
      const [result] = await service.findAll();

      // 3. Assert: `implemented` es quien distingue este caso, no un campo nulo
      expect(result?.implemented).toBe(false);
      expect(result?.outputFields).toEqual([]);
    });
  });
});
