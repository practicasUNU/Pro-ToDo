import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAiPromptsStore } from './ai-prompts.store';

import type { AiPrompt, AiPromptDetail } from '@/types/ai-prompt';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/ai-prompts.service', () => ({
  fetchAiPrompts: vi.fn(),
  fetchAiPromptById: vi.fn(),
  createAiPrompt: vi.fn(),
  updateAiPrompt: vi.fn(),
  deactivateAiPrompt: vi.fn(),
}));

const service = await import('@services/ai-prompts.service');
const fetchAiPrompts = vi.mocked(service.fetchAiPrompts);
const fetchAiPromptById = vi.mocked(service.fetchAiPromptById);
const createAiPrompt = vi.mocked(service.createAiPrompt);
const updateAiPrompt = vi.mocked(service.updateAiPrompt);
const deactivateAiPrompt = vi.mocked(service.deactivateAiPrompt);

const PROMPT_ID = '3c9a1f52-8b47-4d21-9e06-5a7b8c9d0e1f';
const OTHER_PROMPT_ID = '9f8e7d6c-5b4a-4321-8765-1a2b3c4d5e6f';
const AUTHOR_ID = 'd4e5f6a7-b8c9-4012-a345-6b7c8d9e0f12';

const buildPrompt = (overrides: Partial<AiPrompt> = {}): AiPrompt => ({
  id: PROMPT_ID,
  name: 'extraccion-noticia-es',
  description: 'Extrae titular y resumen de un correo',
  active: true,
  createdById: AUTHOR_ID,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const buildDetail = (overrides: Partial<AiPromptDetail> = {}): AiPromptDetail => ({
  ...buildPrompt(),
  promptText: 'Extrae el titular de: {{parsed_email.clean_body}}',
  ...overrides,
});

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe('useAiPromptsStore · repositorio de prompts de IA', () => {
  describe('1. Carga del listado', () => {
    it('1.1 deberia omitir los retirados por defecto', async () => {
      // 1. Arrange
      const store = useAiPromptsStore();
      fetchAiPrompts.mockResolvedValue([buildPrompt()]);

      // 2. Act
      await store.loadPrompts();

      // 3. Assert: el consumidor natural del defecto es el selector del nodo IA,
      //    donde ofrecer un prompt dado de baja seria un Poka-Yoke al reves.
      expect(fetchAiPrompts).toHaveBeenCalledWith(true);
      expect(store.prompts).toHaveLength(1);
    });

    it('1.2 deberia incluir los retirados cuando se piden', async () => {
      // 1. Arrange
      const store = useAiPromptsStore();
      fetchAiPrompts.mockResolvedValue([]);

      // 2. Act
      await store.loadPrompts(false);

      // 3. Assert: es lo que pide la tabla administrativa, unica via para
      //    reactivar un prompt tras el borrado logico.
      expect(fetchAiPrompts).toHaveBeenCalledWith(false);
    });

    it('1.3 deberia apagar isLoading aunque el servicio falle', async () => {
      // 1. Arrange: es lo unico que verifica de verdad el `finally`. Sin el, un
      //    error dejaria la tabla girando para siempre.
      const store = useAiPromptsStore();
      fetchAiPrompts.mockRejectedValue(new Error('500'));

      // 2. Act
      await expect(store.loadPrompts()).rejects.toThrow('500');

      // 3. Assert
      expect(store.isLoading).toBe(false);
    });

    it('1.4 NO deberia capturar el error: lo decide el componente', async () => {
      // 1. Arrange
      const store = useAiPromptsStore();
      fetchAiPrompts.mockRejectedValue(new Error('403'));

      // 2. Act & 3. Assert: el store no conoce al usuario ni sabe que mensaje
      //    mostrarle (frontend-architecture.md §2.1).
      await expect(store.loadPrompts()).rejects.toThrow('403');
    });
  });

  describe('2. Detalle', () => {
    it('2.1 deberia poblar activePrompt con la instruccion completa', async () => {
      // 1. Arrange: el listado no trae `promptText`, por eso hace falta pedirlo.
      const store = useAiPromptsStore();
      fetchAiPromptById.mockResolvedValue(buildDetail());

      // 2. Act
      const detail = await store.loadPromptById(PROMPT_ID);

      // 3. Assert
      expect(fetchAiPromptById).toHaveBeenCalledWith(PROMPT_ID);
      expect(store.activePrompt?.promptText).toBe(
        'Extrae el titular de: {{parsed_email.clean_body}}',
      );
      // `toEqual` y no `toBe`: el store devuelve el valor a traves de un proxy
      // reactivo de Pinia, asi que la identidad no se conserva aunque el objeto
      // sea el mismo.
      expect(detail).toEqual(store.activePrompt);
    });
  });

  describe('3. Alta', () => {
    it('3.1 deberia anadir el prompt creado sin mutar el arreglo previo', async () => {
      // 1. Arrange
      const store = useAiPromptsStore();
      fetchAiPrompts.mockResolvedValue([buildPrompt({ id: OTHER_PROMPT_ID })]);
      await store.loadPrompts();
      const before = store.prompts;

      createAiPrompt.mockResolvedValue(buildDetail());

      // 2. Act
      await store.createPrompt({ name: 'nuevo', promptText: 'texto' });

      // 3. Assert: se reemplaza la referencia, no se hace push (inmutabilidad).
      expect(store.prompts).toHaveLength(2);
      expect(store.prompts).not.toBe(before);
      expect(before).toHaveLength(1);
    });
  });

  describe('4. Edicion', () => {
    it('4.1 deberia sustituir solo la fila editada', async () => {
      // 1. Arrange
      const store = useAiPromptsStore();
      fetchAiPrompts.mockResolvedValue([
        buildPrompt(),
        buildPrompt({ id: OTHER_PROMPT_ID, name: 'otro-prompt' }),
      ]);
      await store.loadPrompts();

      updateAiPrompt.mockResolvedValue(buildDetail({ name: 'renombrado' }));

      // 2. Act
      await store.updatePrompt(PROMPT_ID, { name: 'renombrado' });

      // 3. Assert
      expect(store.prompts[0]?.name).toBe('renombrado');
      expect(store.prompts[1]?.name).toBe('otro-prompt');
    });
  });

  describe('5. Retirada (borrado logico)', () => {
    it('5.1 deberia dejar la fila en la tabla con active en false', async () => {
      // 1. Arrange
      const store = useAiPromptsStore();
      fetchAiPrompts.mockResolvedValue([buildPrompt()]);
      await store.loadPrompts(false);

      deactivateAiPrompt.mockResolvedValue(buildDetail({ active: false }));

      // 2. Act
      await store.deletePrompt(PROMPT_ID);

      // 3. Assert: se sustituye con `map` y NO se saca con `filter`. Sacarla
      //    dejaria el prompt irrecuperable desde la interfaz, porque el boton de
      //    reactivar vive en esa misma fila.
      expect(store.prompts).toHaveLength(1);
      expect(store.prompts[0]?.active).toBe(false);
    });

    it('5.2 deberia apagar isLoading aunque el borrado falle', async () => {
      // 1. Arrange
      const store = useAiPromptsStore();
      deactivateAiPrompt.mockRejectedValue(new Error('404'));

      // 2. Act
      await expect(store.deletePrompt(PROMPT_ID)).rejects.toThrow('404');

      // 3. Assert
      expect(store.isLoading).toBe(false);
    });
  });
});
