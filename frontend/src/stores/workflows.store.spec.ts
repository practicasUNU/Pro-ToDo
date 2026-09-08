import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useWorkflowsStore } from './workflows.store';

import { NodeType } from '@/types/pipeline';

import type { PipelineSummary } from '@/types/pipeline';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/workflows.service', () => ({
  fetchWorkflows: vi.fn(),
  createWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
}));

const workflowsService = await import('@services/workflows.service');
const fetchWorkflows = vi.mocked(workflowsService.fetchWorkflows);
const updateWorkflow = vi.mocked(workflowsService.updateWorkflow);

const WORKFLOW_ID = 'f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b';
const OTHER_WORKFLOW_ID = 'a2b3c4d5-e6f7-4809-9b0c-1d2e3f4a5b6c';
const TEMPLATE_ID = 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

const buildWorkflow = (overrides: Partial<PipelineSummary> = {}): PipelineSummary => ({
  id: WORKFLOW_ID,
  name: 'Notiweb - publicacion automatica',
  description: 'Publica noticias entrantes en el CMS',
  active: false,
  templateId: TEMPLATE_ID,
  topology: [
    { nodeId: 'trigger_imap', nodeType: NodeType.TRIGGER_IMAP, outputNamespace: 'raw_email' },
  ],
  ...overrides,
});

describe('useWorkflowsStore · catalogo de flujos instanciados', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  describe('1. Carga del catalogo', () => {
    it('1.1 deberia cargar los flujos', async () => {
      // 1. Arrange
      const store = useWorkflowsStore();
      fetchWorkflows.mockResolvedValue([buildWorkflow()]);

      // 2. Act
      await store.fetchWorkflows();

      // 3. Assert
      expect(store.workflows).toHaveLength(1);
      expect(store.workflows[0]?.id).toBe(WORKFLOW_ID);
    });

    it('1.2 deberia contar solo los habilitados', async () => {
      // 1. Arrange
      const store = useWorkflowsStore();
      fetchWorkflows.mockResolvedValue([
        buildWorkflow({ active: true }),
        buildWorkflow({ id: OTHER_WORKFLOW_ID, active: false }),
      ]);

      // 2. Act
      await store.fetchWorkflows();

      // 3. Assert
      expect(store.activeCount).toBe(1);
    });

    it('1.3 deberia apagar isLoading aunque el servicio lance', async () => {
      // 1. Arrange
      const store = useWorkflowsStore();
      fetchWorkflows.mockRejectedValue(new Error('500 Internal Server Error'));

      // 2. Act & 3. Assert: el store solo garantiza el `finally`; el mensaje lo
      //    decide el componente (`frontend-architecture.md` §2.1).
      await expect(store.fetchWorkflows()).rejects.toThrow('500 Internal Server Error');
      expect(store.isLoading).toBe(false);
    });
  });

  describe('2. Edicion', () => {
    it('2.1 deberia reemplazar la fila con lo que devuelve el backend', async () => {
      // 1. Arrange
      const store = useWorkflowsStore();
      fetchWorkflows.mockResolvedValue([buildWorkflow()]);
      await store.fetchWorkflows();
      updateWorkflow.mockResolvedValue(buildWorkflow({ name: 'Notiweb v2' }));

      // 2. Act
      await store.updateWorkflow(WORKFLOW_ID, { name: 'Notiweb v2' });

      // 3. Assert: se escribe la RESPUESTA y no un parche optimista. Activar
      //    puede fallar con un 400 si el esquema ya no es integro, y adelantar
      //    el cambio mentiria sobre el estado real del flujo.
      expect(store.workflows[0]?.name).toBe('Notiweb v2');
    });

    it('2.2 no deberia tocar las demas filas', async () => {
      // 1. Arrange
      const store = useWorkflowsStore();
      fetchWorkflows.mockResolvedValue([
        buildWorkflow(),
        buildWorkflow({ id: OTHER_WORKFLOW_ID, name: 'Otro flujo' }),
      ]);
      await store.fetchWorkflows();
      updateWorkflow.mockResolvedValue(buildWorkflow({ name: 'Notiweb v2' }));

      // 2. Act
      await store.updateWorkflow(WORKFLOW_ID, { name: 'Notiweb v2' });

      // 3. Assert
      expect(store.workflows[1]?.name).toBe('Otro flujo');
    });

    it('2.3 deberia propagar el error sin dejar isLoading encendido', async () => {
      // 1. Arrange
      const store = useWorkflowsStore();
      updateWorkflow.mockRejectedValue(new Error('404 Not Found'));

      // 2. Act & 3. Assert
      await expect(store.updateWorkflow(WORKFLOW_ID, { name: 'x' })).rejects.toThrow(
        '404 Not Found',
      );
      expect(store.isLoading).toBe(false);
    });
  });

  describe('3. Habilitacion', () => {
    it('3.1 deberia enviar solo el estado al activar', async () => {
      // 1. Arrange
      const store = useWorkflowsStore();
      updateWorkflow.mockResolvedValue(buildWorkflow({ active: true }));

      // 2. Act
      await store.setActive(WORKFLOW_ID, true);

      // 3. Assert: un cambio de estado no debe reenviar el grafo completo.
      expect(updateWorkflow).toHaveBeenCalledWith(WORKFLOW_ID, { active: true });
    });

    it('3.2 deberia reflejar el estado devuelto por el backend', async () => {
      // 1. Arrange
      const store = useWorkflowsStore();
      fetchWorkflows.mockResolvedValue([buildWorkflow({ active: false })]);
      await store.fetchWorkflows();
      updateWorkflow.mockResolvedValue(buildWorkflow({ active: true }));

      // 2. Act
      await store.setActive(WORKFLOW_ID, true);

      // 3. Assert
      expect(store.workflows[0]?.active).toBe(true);
      expect(store.activeCount).toBe(1);
    });

    it('3.3 no deberia cambiar el estado local si la activacion falla', async () => {
      // 1. Arrange
      const store = useWorkflowsStore();
      fetchWorkflows.mockResolvedValue([buildWorkflow({ active: false })]);
      await store.fetchWorkflows();
      // El backend rechaza activar un flujo sin esquema valido.
      updateWorkflow.mockRejectedValue(new Error('400 Bad Request'));

      // 2. Act & 3. Assert
      await expect(store.setActive(WORKFLOW_ID, true)).rejects.toThrow('400 Bad Request');
      expect(store.workflows[0]?.active).toBe(false);
    });
  });
});
