// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { QBtn, QCard, QCardActions, QCardSection, QDialog, QIcon, Quasar } from 'quasar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import WarningModal from '@components/shared/WarningModal.vue';
import SafeDeleteModal from '@components/shared/SafeDeleteModal.vue';

/**
 * Pruebas "a mala leche" del aviso de 5 s (GUIA_PRUEBAS_MALA_LECHE.md §6).
 *
 * El proyecto no tiene Cypress ni Playwright: el "e2e" de un dialogo es
 * montarlo de verdad, con Quasar real, reloj falso y clics sobre el DOM. Lo que
 * importa es lo que un usuario impaciente intentaria: pulsar antes de tiempo,
 * cerrar y reabrir para "ahorrarse" la espera, o salir por la tangente.
 */

const mountModal = (component: typeof WarningModal, modelValue = false) =>
  mount(component, {
    props: { modelValue, confirmLabel: 'Registrar tarifa' },
    attachTo: document.body,
    global: {
      plugins: [Quasar],
      components: { QBtn, QCard, QCardActions, QCardSection, QDialog, QIcon },
    },
  });

/** El dialogo se teletransporta al `body`: se busca alli, no en el wrapper. */
const confirmButton = (): HTMLButtonElement | null =>
  document.body.querySelector<HTMLButtonElement>('[data-test="warning-confirm"]');

const isDisabled = (button: HTMLElement | null): boolean =>
  button?.classList.contains('disabled') === true ||
  button?.getAttribute('aria-disabled') === 'true';

const open = async (wrapper: ReturnType<typeof mountModal>): Promise<void> => {
  await wrapper.setProps({ modelValue: true });
  await flushPromises();
};

describe('WarningModal (cuenta atras de 5 s)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('1.1 deberia mantener el boton bloqueado hasta el segundo 5', async () => {
    // 1. Arrange 📐
    const wrapper = mountModal(WarningModal);
    await open(wrapper);

    // 2. Act ⚙️ + 3. Assert 🎯: a los 4,9 s sigue bloqueado; a los 5, no.
    expect(confirmButton()?.textContent).toContain('Espera 5s');
    expect(isDisabled(confirmButton())).toBe(true);

    await vi.advanceTimersByTimeAsync(4_900);
    expect(isDisabled(confirmButton())).toBe(true);
    expect(confirmButton()?.textContent).toContain('Espera 1s');

    await vi.advanceTimersByTimeAsync(100);
    expect(isDisabled(confirmButton())).toBe(false);
    expect(confirmButton()?.textContent).toContain('Registrar tarifa');
  });

  it('1.2 NO deberia emitir confirm por mucho que se pulse antes de tiempo', async () => {
    // 1. Arrange 📐: el usuario impaciente aporrea el boton.
    const wrapper = mountModal(WarningModal);
    await open(wrapper);

    // 2. Act ⚙️
    for (let second = 0; second < 4; second += 1) {
      confirmButton()?.click();
      await vi.advanceTimersByTimeAsync(1_000);
    }

    // 3. Assert 🎯
    expect(wrapper.emitted('confirm')).toBeUndefined();
  });

  it('1.3 deberia confirmar UNA vez y cerrarse al pulsar tras la espera', async () => {
    // 1. Arrange 📐
    const wrapper = mountModal(WarningModal);
    await open(wrapper);
    await vi.advanceTimersByTimeAsync(5_000);

    // 2. Act ⚙️
    confirmButton()?.click();
    await flushPromises();

    // 3. Assert 🎯
    expect(wrapper.emitted('confirm')).toHaveLength(1);
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false]);
  });

  it('1.4 deberia REINICIAR la espera al cerrar y reabrir', async () => {
    // 1. Arrange 📐: abrir, esperar 4 s, cerrar y reabrir no puede heredar el
    //    tiempo ya consumido; si lo hiciera, la espera se esquivaria a plazos.
    const wrapper = mountModal(WarningModal);
    await open(wrapper);
    await vi.advanceTimersByTimeAsync(4_000);
    await wrapper.setProps({ modelValue: false });
    await flushPromises();

    // 2. Act ⚙️
    await open(wrapper);
    await vi.advanceTimersByTimeAsync(1_000);

    // 3. Assert 🎯
    expect(isDisabled(confirmButton())).toBe(true);
    expect(confirmButton()?.textContent).toContain('Espera 4s');
  });

  it('1.5 deberia arrancar la cuenta aunque se monte ya abierto', async () => {
    // 1. Arrange 📐: con un `watch` sin `immediate` se quedaba en 5 para siempre.
    mountModal(WarningModal, true);
    await flushPromises();

    // 2. Act ⚙️
    await vi.advanceTimersByTimeAsync(5_000);

    // 3. Assert 🎯
    expect(isDisabled(confirmButton())).toBe(false);
  });

  it('1.6 deberia ser persistente y su "Cancelar" nunca deberia confirmar', async () => {
    // 1. Arrange 📐
    const wrapper = mountModal(WarningModal);
    await open(wrapper);

    // 2. Act ⚙️
    document.body.querySelector<HTMLButtonElement>('[data-test="warning-cancel"]')?.click();
    await flushPromises();

    // 3. Assert 🎯: ni el clic fuera ni `Esc` lo cierran; solo Cancelar.
    expect(wrapper.findComponent(QDialog).props('persistent')).toBe(true);
    expect(wrapper.emitted('cancel')).toHaveLength(1);
    expect(wrapper.emitted('confirm')).toBeUndefined();
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false]);
  });

  it('1.7 SafeDeleteModal deberia compartir la misma espera', async () => {
    // 1. Arrange 📐: la cuenta atras salio de este componente a
    //    `useConfirmCountdown`; el refactor no puede haberla aflojado.
    const wrapper = mountModal(SafeDeleteModal);
    await open(wrapper);
    const dangerButton = (): HTMLButtonElement | null =>
      document.body.querySelector<HTMLButtonElement>('.pd-btn-danger');

    // 2. Act ⚙️
    dangerButton()?.click();
    await vi.advanceTimersByTimeAsync(4_999);
    dangerButton()?.click();

    // 3. Assert 🎯
    expect(wrapper.emitted('confirm')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    dangerButton()?.click();
    expect(wrapper.emitted('confirm')).toHaveLength(1);
  });
});
