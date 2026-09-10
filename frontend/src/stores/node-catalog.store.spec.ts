import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useNodeCatalogStore } from './node-catalog.store';

import { NodeCategory } from '@/types/node-catalog';
import { NodeType } from '@/types/pipeline';

import type { NodeCatalogEntry } from '@/types/node-catalog';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/node-catalog.service', () => ({
  fetchNodeCatalog: vi.fn(),
}));

const service = await import('@services/node-catalog.service');
const fetchNodeCatalog = vi.mocked(service.fetchNodeCatalog);

const buildEntry = (overrides: Partial<NodeCatalogEntry> = {}): NodeCatalogEntry => ({
  id: 'a1',
  code: NodeType.TRIGGER_IMAP,
  name: 'Disparador IMAP',
  category: NodeCategory.TRIGGER,
  description: null,
  uiSchema: {},
  implemented: true,
  ...overrides,
});

const IMPLEMENTED = buildEntry();
const NOT_IMPLEMENTED = buildEntry({
  id: 'a2',
  code: 'TRIGGER_CRON',
  name: 'Disparador Cron',
  implemented: false,
});

describe('useNodeCatalogStore · catalogo de tipos de nodo', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    fetchNodeCatalog.mockResolvedValue([IMPLEMENTED, NOT_IMPLEMENTED]);
  });

  describe('1. Carga', () => {
    it('1.1 deberia poblar las entradas desde el servicio', async () => {
      // 1. Arrange
      const store = useNodeCatalogStore();

      // 2. Act
      await store.fetchCatalog();

      // 3. Assert
      expect(store.entries).toEqual([IMPLEMENTED, NOT_IMPLEMENTED]);
      expect(fetchNodeCatalog).toHaveBeenCalledTimes(1);
    });

    // Es data de instalacion: no cambia entre despliegues, y el dialogo se abre
    // muchas veces por sesion.
    it('1.2 NO deberia repetir la peticion si el catalogo ya esta cargado', async () => {
      // 1. Arrange
      const store = useNodeCatalogStore();
      await store.fetchCatalog();

      // 2. Act
      await store.fetchCatalog();

      // 3. Assert
      expect(fetchNodeCatalog).toHaveBeenCalledTimes(1);
    });

    it('1.3 deberia repetirla con force, para recargar tras una migracion', async () => {
      // 1. Arrange
      const store = useNodeCatalogStore();
      await store.fetchCatalog();

      // 2. Act
      await store.fetchCatalog(true);

      // 3. Assert
      expect(fetchNodeCatalog).toHaveBeenCalledTimes(2);
    });

    it('1.4 deberia apagar isLoading aunque el servicio falle', async () => {
      // 1. Arrange
      const store = useNodeCatalogStore();
      fetchNodeCatalog.mockRejectedValue(new Error('503'));

      // 2. Act
      await expect(store.fetchCatalog()).rejects.toThrow('503');

      // 3. Assert
      expect(store.isLoading).toBe(false);
    });
  });

  describe('2. Tipos ofrecibles en el selector', () => {
    it('2.1 deberia excluir de selectableEntries los tipos sin estrategia', async () => {
      // 1. Arrange
      const store = useNodeCatalogStore();

      // 2. Act
      await store.fetchCatalog();

      // 3. Assert: el catalogo completo sigue disponible para pintarlos atenuados
      expect(store.selectableEntries).toEqual([IMPLEMENTED]);
      expect(store.entries).toHaveLength(2);
    });
  });

  describe('3. Resolucion por codigo', () => {
    it('3.1 deberia encontrar una entrada por su code', async () => {
      // 1. Arrange
      const store = useNodeCatalogStore();
      await store.fetchCatalog();

      // 2. Act
      const found = store.findByCode('TRIGGER_CRON');

      // 3. Assert
      expect(found).toEqual(NOT_IMPLEMENTED);
    });

    it('3.2 deberia devolver null para un codigo desconocido', async () => {
      // 1. Arrange
      const store = useNodeCatalogStore();
      await store.fetchCatalog();

      // 2. Act & 3. Assert
      expect(store.findByCode('NO_EXISTE')).toBeNull();
    });
  });
});
