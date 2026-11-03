// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  QBtn,
  QCard,
  QCardActions,
  QCardSection,
  QChip,
  QDialog,
  QIcon,
  QSelect,
  QSpinner,
  Quasar,
} from 'quasar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { notify } = vi.hoisted(() => ({ notify: vi.fn() }));

vi.mock('quasar', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('quasar')),
  useQuasar: () => ({ notify }),
}));

vi.mock('@services/prompts.service', () => ({
  optimizePrompt: vi.fn(),
}));

import PromptOptimizerModal from '@components/shared/PromptOptimizerModal.vue';

import { optimizePrompt } from '@services/prompts.service';

import type { PromptOptimizationResult } from '@/types/prompt-optimizer';

const DRAFT = 'Resume la noticia de {{parsed_email.clean_title}}.';

const RESULT: PromptOptimizationResult = {
  optimizedPrompt:
    'Eres un redactor institucional. Resume en tres parrafos {{parsed_email.clean_title}}.',
  recommendedVariables: {
    mandatory: ['parsed_email.clean_body'],
    optional: ['parsed_email.clean_title', 'scraped_web.published_at'],
  },
  rationale: 'El borrador no define rol; la directiva del editor es indispensable.',
  recommendations: ['Se anadio un rol explicito.', 'Se fijo la extension de la salida.'],
  telemetry: {
    tokensPrompt: 1_200,
    tokensCompletion: 400,
    tokensReasoning: 100,
    estimatedCostUSD: 0.0074,
    isEstimated: false,
    provider: 'GEMINI',
    model: 'gemini-3.6-flash',
  },
};

const mountModal = () =>
  mount(PromptOptimizerModal, {
    props: { modelValue: true, draftPrompt: DRAFT, defaultFormat: 'html' },
    attachTo: document.body,
    global: {
      plugins: [Quasar],
      components: {
        QBtn,
        QCard,
        QCardActions,
        QCardSection,
        QChip,
        QDialog,
        QIcon,
        QSelect,
        QSpinner,
      },
    },
  });

/** El dialogo se teletransporta al `body`: se busca alli, no en el wrapper. */
const find = (selector: string): HTMLElement | null => document.body.querySelector(selector);

/** Abre el modal y genera la propuesta, el camino comun de casi todos los tests. */
const mountWithProposal = async () => {
  vi.mocked(optimizePrompt).mockResolvedValue(RESULT);
  const wrapper = mountModal();
  await flushPromises();
  find('[data-test="optimizer-generate"]')?.click();
  await flushPromises();

  return wrapper;
};

describe('PromptOptimizerModal', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('1.1 NO deberia llamar al servicio hasta pulsar "Generar propuesta"', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️: cada propuesta es una inferencia de pago.
    mountModal();
    await flushPromises();

    // 3. Assert 🎯
    expect(optimizePrompt).not.toHaveBeenCalled();
    expect(find('[data-test="optimizer-empty"]')).not.toBeNull();
    expect(find('[data-test="optimizer-apply"]')?.hasAttribute('disabled')).toBe(true);
  });

  it('1.2 deberia pedir la optimizacion con el borrador y el formato elegido', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    await mountWithProposal();

    // 3. Assert 🎯
    expect(optimizePrompt).toHaveBeenCalledWith({
      draftPrompt: DRAFT,
      targetFormat: 'html',
      cardinality: 'SINGLE',
    });
  });

  it('1.3 deberia mostrar la propuesta y cada recomendacion', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    await mountWithProposal();

    // 3. Assert 🎯
    expect(find('[data-test="optimizer-proposal"]')?.textContent).toContain(
      'Eres un redactor institucional.',
    );
    const items = find('[data-test="optimizer-recommendations"]')?.querySelectorAll('li');
    expect(Array.from(items ?? []).map((item) => item.textContent?.trim())).toEqual(
      RESULT.recommendations,
    );
  });

  it('1.3b deberia pintar las variables obligatorias en rojo y las opcionales en acento', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    await mountWithProposal();

    // 3. Assert 🎯: el texto lleva el asterisco, ademas del color.
    const mandatory = document.body.querySelectorAll('[data-test="optimizer-variable-mandatory"]');
    const optional = document.body.querySelectorAll('[data-test="optimizer-variable-optional"]');
    expect(Array.from(mandatory).map((chip) => chip.textContent)).toEqual([
      '{{*parsed_email.clean_body}}',
    ]);
    expect(mandatory[0]?.classList.contains('pd-chip-mandatory')).toBe(true);
    expect(Array.from(optional).map((chip) => chip.textContent)).toEqual([
      '{{parsed_email.clean_title}}',
      '{{scraped_web.published_at}}',
    ]);
    expect(optional[0]?.classList.contains('pd-chip-optional')).toBe(true);
    expect(find('[data-test="optimizer-rationale"]')?.textContent).toContain(
      'la directiva del editor es indispensable',
    );
  });

  it('1.3c NO deberia mostrar el bloque de variables si la propuesta no tiene ninguna', async () => {
    // 1. Arrange 📐
    vi.mocked(optimizePrompt).mockResolvedValue({
      ...RESULT,
      recommendedVariables: { mandatory: [], optional: [] },
    });
    mountModal();
    await flushPromises();

    // 2. Act ⚙️
    find('[data-test="optimizer-generate"]')?.click();
    await flushPromises();

    // 3. Assert 🎯
    expect(find('[data-test="optimizer-variables"]')).toBeNull();
  });

  it('1.4 deberia desplegar el consumo de tokens y el coste en USD', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    await mountWithProposal();

    // 3. Assert 🎯: 1200 + 400 + 100 tokens y el coste con formato es-ES.
    const usage = find('[data-test="optimizer-usage"]')?.textContent ?? '';
    expect(usage).toContain('1700 tokens');
    expect(usage).toMatch(/0,0074\s*US\$/);
  });

  it('1.5 "Aplicar Prompt" deberia emitir la propuesta y cerrar el modal', async () => {
    // 1. Arrange 📐
    const wrapper = await mountWithProposal();

    // 2. Act ⚙️
    find('[data-test="optimizer-apply"]')?.click();
    await flushPromises();

    // 3. Assert 🎯
    expect(wrapper.emitted('apply')?.[0]).toEqual([RESULT.optimizedPrompt]);
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false]);
  });

  it('1.6 deberia avisar del fallo sin ofrecer nada que aplicar', async () => {
    // 1. Arrange 📐
    vi.mocked(optimizePrompt).mockRejectedValue(new Error('503'));
    mountModal();
    await flushPromises();

    // 2. Act ⚙️
    find('[data-test="optimizer-generate"]')?.click();
    await flushPromises();

    // 3. Assert 🎯
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'negative' }));
    expect(find('[data-test="optimizer-apply"]')?.hasAttribute('disabled')).toBe(true);
  });
});
