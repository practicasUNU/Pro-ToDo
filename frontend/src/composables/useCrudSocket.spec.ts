// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO: montar un componente anfitrion exige DOM, y los specs
// de store arrancan mas rapido sin el.
import { mount } from '@vue/test-utils';

import { WorkflowStatus } from '@/types/pipeline';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Se dobla el servicio del socket entero: lo que se prueba es el ENCAMINADO
// hacia cada store, no el transporte.
vi.mock('@services/socket-events.service', () => ({
  subscribeToCrudMutations: vi.fn(),
  joinFlowRoom: vi.fn().mockResolvedValue({ ok: true }),
  leaveFlowRoom: vi.fn().mockResolvedValue({ ok: true }),
}));

// Los stores alcanzan `@boot/axios` a traves de sus servicios, y ese modulo
// necesita el entorno de Quasar. Ninguna prueba de aqui dispara una peticion:
// los dobles solo tienen que existir para romper esa cadena de importacion.
vi.mock('@services/users.service', () => ({
  fetchUsers: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  deactivateUser: vi.fn(),
}));

vi.mock('@services/allowed-ips.service', () => ({
  fetchAllowedIps: vi.fn(),
  createAllowedIp: vi.fn(),
  updateAllowedIp: vi.fn(),
  deleteAllowedIp: vi.fn(),
}));

vi.mock('@services/templates.service', () => ({
  fetchTemplates: vi.fn(),
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deactivateTemplate: vi.fn(),
  previewTemplate: vi.fn(),
  fetchTemplate: vi.fn(),
}));

vi.mock('@services/workflow-templates.service', () => ({
  fetchWorkflowTemplates: vi.fn(),
  fetchWorkflowTemplate: vi.fn(),
  createWorkflowTemplate: vi.fn(),
  updateWorkflowTemplate: vi.fn(),
  deactivateWorkflowTemplate: vi.fn(),
}));

vi.mock('@services/fsm.service', () => ({
  fetchNodeCatalog: vi.fn(),
}));

vi.mock('@services/workflows.service', () => ({
  fetchWorkflows: vi.fn(),
  fetchWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
}));

// Entra en la cadena desde que el canvas tambien escucha las mutaciones de
// flujos: su store carga la ejecucion viva por este servicio.
vi.mock('@services/fsm-executions.service', () => ({
  fetchActiveExecution: vi.fn(),
  fetchExecutions: vi.fn(),
  fetchExecution: vi.fn(),
  resumeExecution: vi.fn(),
  discardExecution: vi.fn(),
}));

vi.mock('@services/ai-prompt-templates.service', () => ({
  fetchAiPromptTemplates: vi.fn(),
  fetchAiPromptTemplate: vi.fn(),
  createAiPromptTemplate: vi.fn(),
  updateAiPromptTemplate: vi.fn(),
  deleteAiPromptTemplate: vi.fn(),
}));

import { useCrudSocket } from '@/composables/useCrudSocket';
import { subscribeToCrudMutations } from '@services/socket-events.service';
import { useAllowedIpsStore } from '@stores/allowed-ips.store';
import { useCanvasStore } from '@stores/canvas.store';
import { useUsersStore } from '@stores/users.store';
import { useWorkflowsStore } from '@stores/workflows.store';

import { UserRole } from '@/types/user';

import type { CrudMutationPayload } from '@/types/crud-events';

const USER_ID = 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const IP_ID = 'c4e2d3f5-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const WORKFLOW_ID = 'd5f3e4a6-7c8d-4e9f-a0b1-2c3d4e5f6071';

const buildUser = (overrides = {}) => ({
  id: USER_ID,
  email: 'operador@unuware.com',
  role: UserRole.EDITOR,
  isActive: true,
  ...overrides,
});

const buildAllowedIp = () => ({
  id: IP_ID,
  ipOrCidr: '10.0.0.0/24',
  description: 'Sede central',
  createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z',
});

const buildWorkflow = (overrides = {}) => ({
  id: WORKFLOW_ID,
  name: 'Notiweb',
  description: null,
  status: WorkflowStatus.ACTIVO,
  activeExecutionId: null,
  executionState: null,
  templateId: null,
  topology: [],
  ...overrides,
});

/** Monta un anfitrion minimo: el composable exige ciclo de vida de componente. */
const mountHost = () => {
  const unsubscribe = vi.fn();
  let emit: ((payload: CrudMutationPayload) => void) | null = null;

  vi.mocked(subscribeToCrudMutations).mockImplementation((handler) => {
    emit = handler;

    return unsubscribe;
  });

  const wrapper = mount({
    setup() {
      useCrudSocket();

      return () => null;
    },
  });

  return {
    wrapper,
    unsubscribe,
    emit: (payload: CrudMutationPayload) => emit?.(payload),
  };
};

describe('useCrudSocket · encaminado de mutaciones hacia los stores', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('1.1 deberia insertar la fila creada en el store de usuarios', () => {
    // 1. Arrange 📐
    const usersStore = useUsersStore();
    const host = mountHost();

    // 2. Act ⚙️
    host.emit({
      entity: 'users',
      action: 'CREATED',
      id: USER_ID,
      data: buildUser(),
      emittedAt: '2026-10-11T00:00:00.000Z',
    });

    // 3. Assert 🎯
    expect(usersStore.users).toHaveLength(1);
    expect(usersStore.users[0]?.id).toBe(USER_ID);
  });

  it('1.2 NO deberia duplicar la fila si el CREATED llega repetido', () => {
    // 1. Arrange 📐: quien origina la mutacion ya actualizo su lista con la
    //    respuesta REST y recibe ademas su propio evento.
    const usersStore = useUsersStore();
    usersStore.users = [buildUser()];
    const host = mountHost();

    // 2. Act ⚙️
    host.emit({
      entity: 'users',
      action: 'CREATED',
      id: USER_ID,
      data: buildUser({ email: 'renombrado@unuware.com' }),
      emittedAt: '2026-10-11T00:00:00.000Z',
    });

    // 3. Assert 🎯: se reemplaza, no se apila.
    expect(usersStore.users).toHaveLength(1);
    expect(usersStore.users[0]?.email).toBe('renombrado@unuware.com');
  });

  it('1.3 deberia reemplazar la fila ante una baja logica (UPDATED)', () => {
    // 1. Arrange 📐: desactivar un usuario NO elimina su fila.
    const usersStore = useUsersStore();
    usersStore.users = [buildUser()];
    const host = mountHost();

    // 2. Act ⚙️
    host.emit({
      entity: 'users',
      action: 'UPDATED',
      id: USER_ID,
      data: buildUser({ isActive: false }),
      emittedAt: '2026-10-11T00:00:00.000Z',
    });

    // 3. Assert 🎯
    expect(usersStore.users).toHaveLength(1);
    expect(usersStore.users[0]?.isActive).toBe(false);
  });

  it('1.4 deberia sacar la fila ante un DELETED de allowed_ips', () => {
    // 1. Arrange 📐: unico borrado fisico del sistema, y llega sin `data`.
    const allowedIpsStore = useAllowedIpsStore();
    allowedIpsStore.entries = [buildAllowedIp()];
    const host = mountHost();

    // 2. Act ⚙️
    host.emit({
      entity: 'allowed_ips',
      action: 'DELETED',
      id: IP_ID,
      emittedAt: '2026-10-11T00:00:00.000Z',
    });

    // 3. Assert 🎯
    expect(allowedIpsStore.entries).toHaveLength(0);
  });

  it('1.5 NO deberia tocar un store ajeno a la entidad del evento', () => {
    // 1. Arrange 📐
    const usersStore = useUsersStore();
    const allowedIpsStore = useAllowedIpsStore();
    allowedIpsStore.entries = [buildAllowedIp()];
    const host = mountHost();

    // 2. Act ⚙️
    host.emit({
      entity: 'users',
      action: 'CREATED',
      id: USER_ID,
      data: buildUser(),
      emittedAt: '2026-10-11T00:00:00.000Z',
    });

    // 3. Assert 🎯
    expect(usersStore.users).toHaveLength(1);
    expect(allowedIpsStore.entries).toHaveLength(1);
  });

  it('1.5bis deberia actualizar los metadatos del flujo ante un UPDATED', () => {
    // 1. Arrange 📐: renombrar o conmutar el estado de un flujo es siempre un
    //    `UPDATED`; `workflows` no produce `DELETED` nunca.
    const workflowsStore = useWorkflowsStore();
    workflowsStore.workflows = [buildWorkflow()];
    const host = mountHost();

    // 2. Act ⚙️
    host.emit({
      entity: 'workflows',
      action: 'UPDATED',
      id: WORKFLOW_ID,
      data: buildWorkflow({ name: 'Notiweb v2', status: WorkflowStatus.INACTIVO }),
      emittedAt: '2026-10-11T00:00:00.000Z',
    });

    // 3. Assert 🎯
    expect(workflowsStore.workflows).toHaveLength(1);
    expect(workflowsStore.workflows[0]?.name).toBe('Notiweb v2');
    expect(workflowsStore.workflows[0]?.status).toBe(WorkflowStatus.INACTIVO);
  });

  it('1.5ter NO deberia duplicar el flujo si el CREATED llega repetido', () => {
    // 1. Arrange 📐: quien instancio el flujo ya lo tiene en su lista.
    const workflowsStore = useWorkflowsStore();
    workflowsStore.workflows = [buildWorkflow()];
    const host = mountHost();

    // 2. Act ⚙️
    host.emit({
      entity: 'workflows',
      action: 'CREATED',
      id: WORKFLOW_ID,
      data: buildWorkflow({ name: 'Notiweb renombrado' }),
      emittedAt: '2026-10-11T00:00:00.000Z',
    });

    // 3. Assert 🎯
    expect(workflowsStore.workflows).toHaveLength(1);
    expect(workflowsStore.workflows[0]?.name).toBe('Notiweb renombrado');
  });

  it('1.5quater deberia encaminar la mutacion de flujos TAMBIEN al canvas', () => {
    // 1. Arrange 📐: la via por la que la cabecera del canvas se entera de una
    //    autodesactivacion. Sin este segundo destinatario, la insignia seguia
    //    diciendo «Activo» sobre un flujo cuyo sondeo ya se habia desmontado.
    const canvasStore = useCanvasStore();
    const applyWorkflowMutation = vi.spyOn(canvasStore, 'applyWorkflowMutation');
    const host = mountHost();

    // 2. Act ⚙️
    host.emit({
      entity: 'workflows',
      action: 'UPDATED',
      id: WORKFLOW_ID,
      data: buildWorkflow({ status: WorkflowStatus.INACTIVO }),
      emittedAt: '2026-10-11T00:00:00.000Z',
    });

    // 3. Assert 🎯: el composable encamina; quien descarta lo que no es suyo
    //    es el propio canvas, comparando el `id`.
    expect(applyWorkflowMutation).toHaveBeenCalledWith(
      'UPDATED',
      expect.objectContaining({ status: WorkflowStatus.INACTIVO }),
      WORKFLOW_ID,
    );
  });

  it('1.6 deberia darse de baja al desmontar', () => {
    // 1. Arrange 📐: sin la baja, cada montaje apilaria otro juego de escuchas
    //    y una sola mutacion se aplicaria varias veces.
    const host = mountHost();

    // 2. Act ⚙️
    host.wrapper.unmount();

    // 3. Assert 🎯
    expect(host.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
