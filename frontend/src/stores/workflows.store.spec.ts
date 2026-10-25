import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useWorkflowsStore } from './workflows.store';

import { ExecutionState } from '@/types/execution';
import { WorkflowStatus, NodeType } from '@/types/pipeline';
import { AUDIT_FIXTURE } from '@/testing/audit.fixture';

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
  ...AUDIT_FIXTURE,
  id: WORKFLOW_ID,
  name: 'Notiweb - publicacion automatica',
  description: 'Publica noticias entrantes en el CMS',
  status: WorkflowStatus.INACTIVO,
  activeExecutionId: null,
  executionState: null,
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
        buildWorkflow({ status: WorkflowStatus.ACTIVO }),
        buildWorkflow({ id: OTHER_WORKFLOW_ID, status: WorkflowStatus.INACTIVO }),
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
      updateWorkflow.mockResolvedValue(buildWorkflow({ status: WorkflowStatus.ACTIVO }));

      // 2. Act
      await store.setStatus(WORKFLOW_ID, WorkflowStatus.ACTIVO);

      // 3. Assert: un cambio de estado no debe reenviar el grafo completo.
      expect(updateWorkflow).toHaveBeenCalledWith(WORKFLOW_ID, { status: WorkflowStatus.ACTIVO });
    });

    it('3.2 deberia reflejar el estado devuelto por el backend', async () => {
      // 1. Arrange
      const store = useWorkflowsStore();
      fetchWorkflows.mockResolvedValue([buildWorkflow({ status: WorkflowStatus.INACTIVO })]);
      await store.fetchWorkflows();
      updateWorkflow.mockResolvedValue(buildWorkflow({ status: WorkflowStatus.ACTIVO }));

      // 2. Act
      await store.setStatus(WORKFLOW_ID, WorkflowStatus.ACTIVO);

      // 3. Assert
      expect(store.workflows[0]?.status).toBe(WorkflowStatus.ACTIVO);
      expect(store.activeCount).toBe(1);
    });

    it('3.3 no deberia cambiar el estado local si la activacion falla', async () => {
      // 1. Arrange
      const store = useWorkflowsStore();
      fetchWorkflows.mockResolvedValue([buildWorkflow({ status: WorkflowStatus.INACTIVO })]);
      await store.fetchWorkflows();
      // El backend rechaza activar un flujo sin esquema valido.
      updateWorkflow.mockRejectedValue(new Error('400 Bad Request'));

      // 2. Act & 3. Assert
      await expect(store.setStatus(WORKFLOW_ID, WorkflowStatus.ACTIVO)).rejects.toThrow(
        '400 Bad Request',
      );
      expect(store.workflows[0]?.status).toBe(WorkflowStatus.INACTIVO);
    });
  });

  describe('apagado automatico llegado por el canal', () => {
    it('deberia repintar la fila como inactiva sin recargar', async () => {
      // 1. Arrange 📐: es el caso del flujo con `stopOnFirstSuccess`, que se
      //    apaga solo tras su primer exito. Lo dispara un sondeo, de modo que
      //    nadie lo esta mirando cuando ocurre y la unica via para que la tabla
      //    diga la verdad es esta mutacion.
      const store = useWorkflowsStore();
      store.workflows = [buildWorkflow({ status: WorkflowStatus.ACTIVO })];

      // 2. Act ⚙️
      store.applyMutation(
        'UPDATED',
        buildWorkflow({ status: WorkflowStatus.INACTIVO }),
        WORKFLOW_ID,
      );
      await nextTick();

      // 3. Assert 🎯: la fila se reemplaza ENTERA, no se fusiona.
      expect(store.workflows).toHaveLength(1);
      expect(store.workflows[0]?.status).toBe(WorkflowStatus.INACTIVO);
    });

    it('deberia repintar la fila como PAUSADA cuando la pausa la escribe el motor', async () => {
      // 1. Arrange 📐: `PAUSADO` no se alcanza desde la API —el DTO lo
      //    rechaza—, solo lo escribe el motor al detener una ejecucion. El
      //    operador no ha pulsado nada, asi que el canal es la UNICA via por la
      //    que la tabla puede enterarse sin recargar.
      const store = useWorkflowsStore();
      store.workflows = [buildWorkflow({ status: WorkflowStatus.ACTIVO })];

      // 2. Act ⚙️
      store.applyMutation(
        'UPDATED',
        buildWorkflow({ status: WorkflowStatus.PAUSADO }),
        WORKFLOW_ID,
      );
      await nextTick();

      // 3. Assert 🎯
      expect(store.workflows[0]?.status).toBe(WorkflowStatus.PAUSADO);
    });

    it('NO deberia tocar las filas de otros flujos', async () => {
      // 1. Arrange 📐
      const store = useWorkflowsStore();
      store.workflows = [
        buildWorkflow({ status: WorkflowStatus.ACTIVO }),
        buildWorkflow({ id: OTHER_WORKFLOW_ID, status: WorkflowStatus.ACTIVO }),
      ];

      // 2. Act ⚙️
      store.applyMutation(
        'UPDATED',
        buildWorkflow({ status: WorkflowStatus.INACTIVO }),
        WORKFLOW_ID,
      );
      await nextTick();

      // 3. Assert 🎯
      expect(store.workflows[1]?.status).toBe(WorkflowStatus.ACTIVO);
    });
  });

  describe('4. Reanudacion anunciada por la sala del flujo', () => {
    it('4.1 deberia pasar la fila de Pausado a En proceso sin recargar', () => {
      // 1. Arrange 📐: la foto que dejo la pausa.
      const store = useWorkflowsStore();
      store.workflows = [
        buildWorkflow({
          status: WorkflowStatus.PAUSADO,
          activeExecutionId: 'exec-1',
          executionState: ExecutionState.PAUSADO,
        }),
      ];

      // 2. Act ⚙️
      store.markExecutionResumed(WORKFLOW_ID, 'exec-1');

      // 3. Assert 🎯
      expect(store.workflows[0]?.status).toBe(WorkflowStatus.ACTIVO);
      expect(store.workflows[0]?.executionState).toBe(ExecutionState.EN_PROCESO);
    });

    it('4.2 NO deberia rearmar un flujo INACTIVO al reanudar su ejecucion', () => {
      // 1. Arrange 📐: reanudar no exige el flujo armado, ni lo arma.
      const store = useWorkflowsStore();
      store.workflows = [buildWorkflow({ executionState: ExecutionState.PAUSADO })];

      // 2. Act ⚙️
      store.markExecutionResumed(WORKFLOW_ID, 'exec-1');

      // 3. Assert 🎯
      expect(store.workflows[0]?.status).toBe(WorkflowStatus.INACTIVO);
      expect(store.workflows[0]?.executionState).toBe(ExecutionState.EN_PROCESO);
    });

    it('4.3 NO deberia tocar las filas de otros flujos', () => {
      // 1. Arrange 📐
      const store = useWorkflowsStore();
      const other = buildWorkflow({ id: 'otro', status: WorkflowStatus.PAUSADO });
      store.workflows = [other];

      // 2. Act ⚙️
      store.markExecutionResumed(WORKFLOW_ID, 'exec-1');

      // 3. Assert 🎯
      expect(store.workflows[0]).toEqual(other);
    });
  });
});
