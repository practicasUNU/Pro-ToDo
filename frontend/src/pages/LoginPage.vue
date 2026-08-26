<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useQuasar } from 'quasar';
import { useRoute, useRouter } from 'vue-router';

import { useSessionStore } from '@stores/session.store';

import { corporateEmailErrorMessage, isCorporateEmail } from '@/utils/corporate-email';

/** Vigencia asumida del codigo si el backend no la informa (estandar del briefing). */
const FALLBACK_EXPIRATION_SECONDS = 120;

/** Digitos exactos del codigo OTP, fijados por VerifyOtpDto en el backend. */
const OTP_LENGTH = 6;

const $q = useQuasar();
const route = useRoute();
const router = useRouter();
const sessionStore = useSessionStore();

// Estado local del formulario: vive y muere con esta vista, asi que no sube al
// store (frontend-architecture.md §2.1).
const email = ref('');
const code = ref('');
const otpSent = ref(false);
const secondsRemaining = ref(0);

let countdownId: ReturnType<typeof setInterval> | undefined;

const isCodeExpired = computed(() => otpSent.value && secondsRemaining.value <= 0);

const isCodeComplete = computed(() => code.value.length === OTP_LENGTH);

const submitLabel = computed(() => (otpSent.value ? 'Verificar Codigo' : 'Enviar Codigo'));

// Poka-Yoke: el boton no se habilita hasta que el campo del paso actual valida.
const isSubmitDisabled = computed(() => {
  if (sessionStore.isLoading) return true;
  if (!otpSent.value) return !email.value || !isCorporateEmail(email.value);

  return !isCodeComplete.value || isCodeExpired.value;
});

const clearCountdown = (): void => {
  if (countdownId) {
    clearInterval(countdownId);
    countdownId = undefined;
  }
};

const startCountdown = (totalSeconds: number): void => {
  clearCountdown();
  secondsRemaining.value = totalSeconds;

  countdownId = setInterval(() => {
    if (secondsRemaining.value <= 1) {
      secondsRemaining.value = 0;
      clearCountdown();
      return;
    }

    secondsRemaining.value -= 1;
  }, 1000);
};

/** Vuelve al paso 1 para pedir un codigo nuevo. */
const resetToEmailStep = (): void => {
  clearCountdown();
  otpSent.value = false;
  code.value = '';
  secondsRemaining.value = 0;
};

const sendOtp = async (): Promise<void> => {
  try {
    const expiresInSeconds = await sessionStore.requestOtp(email.value);

    otpSent.value = true;
    code.value = '';
    startCountdown(expiresInSeconds || FALLBACK_EXPIRATION_SECONDS);

    $q.notify({
      type: 'positive',
      message: 'Si el correo existe, recibiras un codigo en tu bandeja.',
    });
  } catch {
    // Respuesta neutra tambien en el cliente: no se confirma si la cuenta existe.
    $q.notify({ type: 'negative', message: 'No se pudo enviar el codigo. Intentalo de nuevo.' });
  }
};

const verifyOtp = async (): Promise<void> => {
  try {
    await sessionStore.verifyOtp(email.value, code.value);
    clearCountdown();

    // `redirect` lo deja la guarda del router al interceptar una ruta protegida.
    const redirectTo = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    await router.replace(redirectTo);
  } catch {
    code.value = '';
    $q.notify({ type: 'negative', message: 'Codigo invalido o expirado.' });
  }
};

const onSubmit = async (): Promise<void> => {
  if (isSubmitDisabled.value) return;

  await (otpSent.value ? verifyOtp() : sendOtp());
};

onBeforeUnmount(clearCountdown);
</script>

<template>
  <q-page class="pd-page">
    <div class="row pd-login-row">
      <!-- Lado izquierdo: identidad institucional sobre superficie subordinada -->
      <div class="col-12 col-md-6 pd-surface-muted pd-login-brand">
        <div class="pd-login-brand__content">
          <q-avatar size="48px" class="q-mb-md">
            <img src="@/assets/unuware-logo-isotype.svg" alt="UNUWARE" />
          </q-avatar>

          <h1 class="pd-h1 q-mb-xs">Proto-Do</h1>

          <a class="pd-link pd-nav" href="https://unuware.com" target="_blank" rel="noopener">
            unuware.com
          </a>

          <p class="pd-subtitle q-mt-md pd-login-brand__description">
            Plataforma de automatizacion FSM para ingesta, inferencia LLM y publicacion en
            Drupal/Acens.
          </p>
        </div>
      </div>

      <!-- Lado derecho: tarjeta del formulario -->
      <div class="col-12 col-md-6 flex flex-center pd-login-form">
        <q-card flat class="pd-card pd-login-card">
          <q-card-section>
            <h2 class="pd-h1">Inicio de Sesion</h2>
            <p class="pd-subtitle q-mt-xs">
              {{
                otpSent
                  ? 'Introduce el codigo de 6 digitos que enviamos a tu correo.'
                  : 'Te enviaremos un codigo temporal a tu correo corporativo.'
              }}
            </p>
          </q-card-section>

          <q-form @submit.prevent="onSubmit">
            <q-card-section class="q-pt-none">
              <!-- Estado 1: solicitud del codigo -->
              <div v-if="!otpSent">
                <label class="pd-label" for="login-email">
                  Correo corporativo<span class="pd-required">*</span>
                </label>
                <q-input
                  id="login-email"
                  v-model="email"
                  type="email"
                  outlined
                  dense
                  autofocus
                  class="q-mt-xs"
                  placeholder="usuario@unuware.com"
                  :rules="[
                    (val: string) => !!val || 'El correo es obligatorio',
                    (val: string) => isCorporateEmail(val) || corporateEmailErrorMessage,
                  ]"
                />
              </div>

              <!-- Estado 2: validacion del codigo -->
              <div v-else>
                <label class="pd-label" for="login-code">
                  Codigo de acceso<span class="pd-required">*</span>
                </label>
                <q-input
                  id="login-code"
                  v-model="code"
                  outlined
                  dense
                  autofocus
                  mask="######"
                  unmasked-value
                  inputmode="numeric"
                  class="q-mt-xs pd-mono pd-login-code"
                  placeholder="000000"
                  :disable="isCodeExpired"
                  :rules="[
                    (val: string) => val.length === OTP_LENGTH || 'El codigo tiene 6 digitos',
                  ]"
                />

                <div class="pd-subtitle q-mt-xs">{{ email }}</div>
              </div>
            </q-card-section>

            <q-card-actions class="q-px-md q-pb-md column items-stretch q-gutter-sm">
              <q-btn
                class="pd-btn-primary full-width"
                unelevated
                no-caps
                type="submit"
                :label="submitLabel"
                icon-right="north_east"
                :disable="isSubmitDisabled"
                :loading="sessionStore.isLoading"
              />

              <!-- Temporizador: mono + rojo institucional, segun regla §2 -->
              <div v-if="otpSent" class="text-center">
                <span v-if="!isCodeExpired" class="pd-mono pd-countdown">
                  {{ secondsRemaining }} segundos restantes
                </span>

                <q-btn
                  v-else
                  flat
                  dense
                  no-caps
                  class="pd-link"
                  label="Reenviar codigo"
                  @click="resetToEmailStep"
                />
              </div>
            </q-card-actions>
          </q-form>
        </q-card>
      </div>
    </div>
  </q-page>
</template>

<style scoped lang="scss">
.pd-login-row {
  min-height: 100vh;
}

.pd-login-brand {
  display: flex;
  align-items: center;
  padding: 48px 40px;
}

.pd-login-brand__content {
  max-width: 380px;
  margin: 0 auto;
}

.pd-login-brand__description {
  max-width: 34ch;
}

.pd-login-form {
  padding: 40px 24px;
}

.pd-login-card {
  width: 100%;
  max-width: 400px;
}

// Codigo OTP: espaciado amplio para leerlo digito a digito.
.pd-login-code :deep(input) {
  letter-spacing: 6px;
}

.pd-countdown {
  color: var(--pd-negative);
}
</style>
