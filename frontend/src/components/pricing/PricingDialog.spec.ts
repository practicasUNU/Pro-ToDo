// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import {
  QBtn,
  QCard,
  QCardActions,
  QCardSection,
  QDialog,
  QForm,
  QIcon,
  QInput,
  QSelect,
  Quasar,
} from 'quasar';
import { afterEach, describe, expect, it } from 'vitest';

import PricingDialog from '@components/pricing/PricingDialog.vue';

import type { ModelPricing } from '@/types/pricing';

const BASE: ModelPricing = {
  id: '0b7d3f5e-1111-4222-8333-944455556666',
  aiProvider: 'GEMINI',
  aiModel: 'gemini-1.5-pro',
  promptRateUsdPerMTok: 1.25,
  completionRateUsdPerMTok: 5,
  reasoningRateUsdPerMTok: 5,
  validFrom: '2026-10-01T00:00:00.000Z',
  active: true,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  createdBy: null,
  updatedBy: null,
};

const mountDialog = (base: ModelPricing | null) =>
  mount(PricingDialog, {
    props: { modelValue: true, base },
    attachTo: document.body,
    global: {
      plugins: [Quasar],
      components: {
        QBtn,
        QCard,
        QCardActions,
        QCardSection,
        QDialog,
        QForm,
        QIcon,
        QInput,
        QSelect,
      },
    },
  });

/** Escribe por el COMPONENTE: un `setValue` nativo no llega al `v-model` de QInput. */
const setInput = async (
  wrapper: ReturnType<typeof mountDialog>,
  dataTest: string,
  value: string | number,
): Promise<void> => {
  const input = wrapper
    .findAllComponents(QInput)
    .find((candidate) => candidate.find(`[data-test="${dataTest}"]`).exists());
  await input?.setValue(value);
};

const submit = async (): Promise<void> => {
  document.body.querySelector('form')?.dispatchEvent(new Event('submit'));
  await flushPromises();
};

describe('PricingDialog', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('1.1 al actualizar deberia FIJAR proveedor y modelo, y emitir sin persistir', async () => {
    // 1. Arrange 📐
    const wrapper = mountDialog(BASE);
    await flushPromises();

    // 2. Act ⚙️
    await setInput(wrapper, 'pricing-prompt', 1.5);
    await submit();

    // 3. Assert 🎯: el par no se puede cambiar; cambiarlo seria otro alta.
    const selects = wrapper.findAllComponents(QSelect);
    expect(selects[0]?.props('disable')).toBe(true);
    expect(wrapper.emitted('requestSave')?.[0]).toEqual([
      {
        aiProvider: 'GEMINI',
        aiModel: 'gemini-1.5-pro',
        promptRateUsdPerMTok: 1.5,
        completionRateUsdPerMTok: 5,
        reasoningRateUsdPerMTok: 5,
      },
    ]);
  });

  it.each([
    ['una tarifa negativa', 'pricing-prompt', -1],
    ['mas de 6 decimales', 'pricing-completion', 0.1234567],
    ['un desbordamiento', 'pricing-reasoning', 1e7],
  ])('1.2 NO deberia emitir con %s', async (_label, field, value) => {
    // 1. Arrange 📐
    const wrapper = mountDialog(BASE);
    await flushPromises();

    // 2. Act ⚙️
    await setInput(wrapper, field, value);
    await submit();

    // 3. Assert 🎯
    expect(wrapper.emitted('requestSave')).toBeUndefined();
  });

  it.each([
    ['XSS', '<img src=x onerror=alert(1)>'],
    ['SQL', "gpt'; DROP TABLE usuarios;--"],
    ['espacios internos', 'gemini pro'],
  ])('1.3 NO deberia emitir un modelo con %s', async (_label, model) => {
    // 1. Arrange 📐: alta nueva, sin `base`, asi que el modelo es editable.
    const fresh = mountDialog(null);
    await flushPromises();
    fresh.findAllComponents(QSelect)[0]?.vm.$emit('update:modelValue', 'OPENAI');
    await setInput(fresh, 'pricing-model', model);
    await setInput(fresh, 'pricing-prompt', 1);
    await setInput(fresh, 'pricing-completion', 1);
    await setInput(fresh, 'pricing-reasoning', 1);

    // 2. Act ⚙️
    await submit();

    // 3. Assert 🎯
    expect(fresh.emitted('requestSave')).toBeUndefined();
  });

  it('1.4 deberia recortar el modelo de un alta nueva', async () => {
    // 1. Arrange 📐
    const wrapper = mountDialog(null);
    await flushPromises();
    wrapper.findAllComponents(QSelect)[0]?.vm.$emit('update:modelValue', 'OPENAI');
    await setInput(wrapper, 'pricing-model', '   gpt-4o   ');
    await setInput(wrapper, 'pricing-prompt', 2.5);
    await setInput(wrapper, 'pricing-completion', 10);
    await setInput(wrapper, 'pricing-reasoning', 10);

    // 2. Act ⚙️
    await submit();

    // 3. Assert 🎯
    expect(wrapper.emitted('requestSave')?.[0]?.[0]).toMatchObject({
      aiProvider: 'OPENAI',
      aiModel: 'gpt-4o',
    });
  });
});
