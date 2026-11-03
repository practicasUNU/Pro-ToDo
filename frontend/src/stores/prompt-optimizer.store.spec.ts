import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { usePromptOptimizerStore } from './prompt-optimizer.store';

import type { PromptOptimizationResult } from '@/types/prompt-optimizer';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/prompts.service', () => ({
  optimizePrompt: vi.fn(),
}));

const promptsService = await import('@services/prompts.service');
const optimizePrompt = vi.mocked(promptsService.optimizePrompt);

const RESULT: PromptOptimizationResult = {
  optimizedPrompt: 'Eres un redactor institucional.',
  recommendedVariables: { mandatory: [], optional: [] },
  rationale: 'Sin rol definido.',
  recommendations: ['Se anadio un rol.'],
  telemetry: {
    tokensPrompt: 100,
    tokensCompletion: 50,
    tokensReasoning: 0,
    estimatedCostUSD: 0.0002,
    isEstimated: false,
    provider: 'GEMINI',
    model: 'gemini-3.6-flash',
  },
};

describe('usePromptOptimizerStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('1.1 deberia guardar la propuesta y apagar isLoading', async () => {
    // 1. Arrange 📐
    optimizePrompt.mockResolvedValue(RESULT);
    const store = usePromptOptimizerStore();

    // 2. Act ⚙️
    await store.optimize({ draftPrompt: 'Resume.', targetFormat: 'text' });

    // 3. Assert 🎯
    expect(optimizePrompt).toHaveBeenCalledWith({
      draftPrompt: 'Resume.',
      targetFormat: 'text',
      cardinality: 'SINGLE',
    });
    expect(store.result).toEqual(RESULT);
    expect(store.isLoading).toBe(false);
  });

  it('1.2 no deberia conservar la propuesta anterior si la nueva falla', async () => {
    // 1. Arrange 📐
    optimizePrompt.mockResolvedValueOnce(RESULT);
    optimizePrompt.mockRejectedValueOnce(new Error('503'));
    const store = usePromptOptimizerStore();
    await store.optimize({ draftPrompt: 'A', targetFormat: 'text' });

    // 2. Act ⚙️ + 3. Assert 🎯
    await expect(store.optimize({ draftPrompt: 'B', targetFormat: 'json' })).rejects.toThrow('503');
    expect(store.result).toBeNull();
    expect(store.isLoading).toBe(false);
  });
});
