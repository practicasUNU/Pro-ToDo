import { computed, onBeforeUnmount, ref, watch } from 'vue';

import type { ComputedRef, Ref } from 'vue';

/** RNF (frontend-quasar.md §4): espera forzada antes de habilitar `@ok`. */
export const CONFIRM_COUNTDOWN_SECONDS = 5;

export interface ConfirmCountdown {
  /** Segundos que faltan; 0 cuando ya se puede confirmar. */
  readonly secondsRemaining: Ref<number>;
  /** `true` mientras la confirmacion siga bloqueada. */
  readonly isLocked: ComputedRef<boolean>;
}

/**
 * Cuenta atras de los dialogos de confirmacion critica.
 *
 * Vivia copiada dentro de `SafeDeleteModal`; al nacer `WarningModal` (la misma
 * espera, con estetica de aviso en lugar de borrado) se extrae aqui para que
 * las dos no diverjan el dia que cambie la regla.
 *
 * Arranca cada vez que el dialogo se ABRE —y se reinicia entera si se cierra y
 * se vuelve a abrir: abrir, esperar 4 s, cerrar y reabrir no puede heredar el
 * tiempo ya consumido—. `immediate` cubre el dialogo que se monta ya abierto,
 * que con un `watch` normal se quedaria bloqueado para siempre en 5.
 *
 * @param isOpen Getter del estado de apertura (normalmente `() => props.modelValue`).
 */
export const useConfirmCountdown = (
  isOpen: () => boolean,
  seconds: number = CONFIRM_COUNTDOWN_SECONDS,
): ConfirmCountdown => {
  const secondsRemaining = ref(seconds);
  let intervalId: ReturnType<typeof setInterval> | undefined;

  const clearCountdown = (): void => {
    if (intervalId !== undefined) {
      clearInterval(intervalId);
      intervalId = undefined;
    }
  };

  const startCountdown = (): void => {
    clearCountdown();
    secondsRemaining.value = seconds;

    intervalId = setInterval(() => {
      if (secondsRemaining.value <= 1) {
        secondsRemaining.value = 0;
        clearCountdown();
        return;
      }

      secondsRemaining.value -= 1;
    }, 1000);
  };

  watch(
    isOpen,
    (open) => {
      if (open) {
        startCountdown();
      } else {
        clearCountdown();
      }
    },
    { immediate: true },
  );

  onBeforeUnmount(clearCountdown);

  return {
    secondsRemaining,
    isLocked: computed(() => secondsRemaining.value > 0),
  };
};
