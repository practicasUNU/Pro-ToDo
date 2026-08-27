<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useQuasar } from 'quasar';
import { useRoute, useRouter } from 'vue-router';

import OtpCodeInput from '@components/session/OtpCodeInput.vue';
import { useSessionStore } from '@stores/session.store';
import { useThemeStore } from '@stores/theme.store';

import { corporateEmailErrorMessage, isCorporateEmail } from '@/utils/corporate-email';

/** Vigencia asumida del codigo si el backend no la informa (estandar del briefing). */
const FALLBACK_EXPIRATION_SECONDS = 120;

/** Digitos exactos del codigo OTP, fijados por VerifyOtpDto en el backend. */
const OTP_LENGTH = 6;

const $q = useQuasar();
const route = useRoute();
const router = useRouter();
const sessionStore = useSessionStore();
const themeStore = useThemeStore();

// Estado local del formulario: vive y muere con esta vista, asi que no sube al
// store (frontend-architecture.md §2.1).
const email = ref('');
const code = ref('');
const otpSent = ref(false);
const secondsRemaining = ref(0);

let countdownId: ReturnType<typeof setInterval> | undefined;

/**
 * El toggle escribe a traves del store, no sobre `$q.dark.isActive` directamente:
 * `isActive` es de solo lectura y, ademas, `useThemeStore` es quien persiste la
 * eleccion en localStorage. Asignarlo a mano perderia el modo al recargar.
 */
const isDarkMode = computed<boolean>({
  get: () => themeStore.isDark,
  set: () => themeStore.toggleTheme(),
});

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
    // Aqui solo se llega por fallo de red, 429 del throttler o 5xx: el backend
    // responde 202 tanto si la cuenta no existe como si esta desactivada, asi
    // que no hay forma (ni intencion) de distinguir esos casos en el cliente.
    $q.notify({
      type: 'negative',
      message: 'No se pudo enviar el codigo. Intentalo de nuevo.',
    });
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

/** Envio automatico al completar las seis casillas, sin pulsar el boton. */
const onCodeComplete = async (): Promise<void> => {
  if (isCodeExpired.value || sessionStore.isLoading) return;

  await verifyOtp();
};

onBeforeUnmount(clearCountdown);
</script>

<template>
  <q-page class="pd-page pd-login-page">
    <div class="row pd-login-row">
      <!-- Lado izquierdo: identidad institucional sobre superficie subordinada.
           La superficie se pinta en el scoped (.pd-login-brand) en vez de con
           la utilidad .pd-surface-muted, porque necesita ser translucida para
           que el patron de fondo de la pagina se lea por debajo. -->
      <div class="col-12 col-md-6 pd-login-brand">
        <div class="pd-login-brand__content">
          <!-- El blanqueo se decide con una clase enlazada al store, no con un
               selector de tema en CSS: `:global(body.body--dark) .x` compila mal
               en scoped CSS (Vue descarta el descendiente y el filtro acaba
               aplicado al <body> entero, blanqueando la pagina completa). -->
          <img
            src="@/assets/unuware-long-logo.png"
            alt="UNUWARE"
            class="pd-login-brand__logo q-mb-lg"
            :class="{ 'pd-login-brand__logo--inverted': themeStore.isDark }"
          />

          <h1 class="pd-h1 pd-login-brand__title q-mb-xs">Proto-Do</h1>

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
          <q-card-section class="row items-start no-wrap">
            <div class="col">
              <h2 class="pd-h2 pd-login-card__title">Inicio de Sesion</h2>
              <p class="pd-subtitle q-mt-xs">
                {{
                  otpSent
                    ? 'Introduce el codigo de 6 digitos que enviamos a tu correo.'
                    : 'Te enviaremos un codigo temporal a tu correo corporativo.'
                }}
              </p>
            </div>

            <!-- Conmutador de tema: el login queda fuera del shell, que es donde
                 vive el ThemeToggle del header -->
            <q-toggle
              v-model="isDarkMode"
              dense
              checked-icon="dark_mode"
              unchecked-icon="light_mode"
              color="primary"
              aria-label="Alternar modo claro y oscuro"
              data-testid="login-theme-toggle"
            >
              <q-tooltip>{{ isDarkMode ? 'Modo claro' : 'Modo oscuro' }}</q-tooltip>
            </q-toggle>
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

              <!-- Estado 3: el codigo caduco. Sustituye por completo a las
                   casillas y al contador, en vez de dejarlas deshabilitadas -->
              <div v-else-if="isCodeExpired">
                <q-banner dense rounded class="pd-banner-expired">
                  <template #avatar>
                    <!-- Sin `color`: hereda el del banner. `color="white"` mapea a
                         la paleta de Quasar, que §2 prohibe como sustituto de un token. -->
                    <q-icon name="schedule" size="22px" />
                  </template>
                  Codigo caducado
                  <div class="pd-banner-expired__hint">
                    El codigo enviado a {{ email }} ya no es valido.
                  </div>
                </q-banner>
              </div>

              <!-- Estado 2: validacion del codigo -->
              <div v-else>
                <label class="pd-label"> Codigo de acceso<span class="pd-required">*</span> </label>

                <otp-code-input
                  v-model="code"
                  autofocus
                  class="q-mt-xs"
                  @complete="onCodeComplete"
                />

                <div class="pd-subtitle q-mt-sm">{{ email }}</div>
              </div>
            </q-card-section>

            <q-card-actions class="q-px-md q-pb-md column items-stretch q-gutter-sm">
              <q-btn
                v-if="isCodeExpired"
                class="pd-btn-primary full-width"
                unelevated
                no-caps
                label="Solicitar un codigo nuevo"
                icon-right="refresh"
                :loading="sessionStore.isLoading"
                @click="resetToEmailStep"
              />

              <template v-else>
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
                  <span class="pd-mono pd-countdown">
                    {{ secondsRemaining }} segundos restantes
                  </span>
                </div>
              </template>
            </q-card-actions>
          </q-form>
        </q-card>
      </div>
    </div>
  </q-page>
</template>

<style scoped lang="scss">
// Patron de fondo del login: dos halos radiales en esquinas opuestas y una
// reticula de puntos, todo derivado de tokens. `color-mix` es lo que permite dar
// opacidad a un token sin quemar el hexadecimal, que es lo que obligaria `rgba()`.
//
// Una sola regla cubre ambos temas: --pd-primary/--pd-primary-light NO conmutan
// (identidad de marca) y --pd-page-bg SI, asi que el mismo tinte al 15% se lee
// como azul palido sobre #FAFBFF y como halo sobre #0D0F26. No hace falta un
// bloque body--dark, ni existe body--light con el que hacer simetria.
//
// Vive aqui y no en app.scss por especificidad: .pd-page declara `background` en
// forma abreviada, que resetea `background-image` a none. Al ser scoped, Vue
// compila esto como .pd-login-page[data-v-x] -> (0,2,0), que gana a .pd-page
// (0,1,0) sin depender del orden de aparicion en el archivo.
//
// Degradacion: `background-color` va en declaracion propia, de modo que si el
// motor no entiende `color-mix` invalida SOLO `background-image` y la pagina se
// queda con el fondo plano del token, nunca sin fondo. No unificar en `background`.
.pd-login-page {
  background-color: var(--pd-page-bg);
  background-image:
    radial-gradient(
      circle at 12% 18%,
      color-mix(in srgb, var(--pd-primary-light) 15%, transparent) 0%,
      transparent 42%
    ),
    radial-gradient(
      circle at 88% 82%,
      color-mix(in srgb, var(--pd-primary) 12%, transparent) 0%,
      transparent 48%
    ),
    radial-gradient(
      circle at 1px 1px,
      color-mix(in srgb, var(--pd-primary-light) 15%, transparent) 1px,
      transparent 0
    );
  background-repeat: no-repeat, no-repeat, repeat;
  background-size:
    100% 100%,
    100% 100%,
    22px 22px;
}

.pd-login-row {
  min-height: 100vh;
}

.pd-login-brand {
  display: flex;
  align-items: center;
  padding: 48px 40px;
  // Fallback opaco primero; la version translucida (para que el patron se lea
  // por debajo) lo sobrescribe donde color-mix esta soportado. Dos declaraciones
  // de la misma propiedad: la ultima valida gana, la invalida se descarta.
  background: var(--pd-surface-muted);
  background: color-mix(in srgb, var(--pd-surface-muted) 72%, transparent);
}

.pd-login-brand__content {
  max-width: 380px;
  margin: 0 auto;
}

// Alto fijo y ancho automatico: preserva la proporcion 1100x200 del PNG
// (44px de alto -> 242px de ancho).
.pd-login-brand__logo {
  display: block;
  height: 44px;
  width: auto;
  max-width: 100%;
}

// El logotipo es azul monocromo: legible sobre el panel claro, pero pierde
// contraste sobre el navy del modo oscuro. Solo ahi se fuerza a blanco, via la
// clase que enlaza la plantilla contra `themeStore.isDark`.
.pd-login-brand__logo--inverted {
  filter: brightness(0) invert(1);
}

// Solo escala: la familia la sigue heredando de .pd-h1, para no declarar
// `font-family` en el componente (regla §2, Tipografia).
.pd-login-brand__title {
  font-size: 34px;
  line-height: 42px;
}

// Idem: .pd-h2 aporta familia y peso; aqui solo se sube un paso la escala
// para que el titulo de la tarjeta no compita con el h1 de marca.
.pd-login-card__title {
  font-size: 19px;
  line-height: 26px;
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

.pd-countdown {
  color: var(--pd-negative);
}

// Banner de caducidad: rojo institucional sobre texto blanco. El blanco sale de
// --pd-shell-text (invariante en la lista cerrada de tokens), igual que hacen
// .pd-btn-primary y .pd-btn-danger en app.scss para texto sobre relleno solido.
.pd-banner-expired {
  background: var(--pd-negative);
  color: var(--pd-shell-text);
  font-weight: 700;
}

.pd-banner-expired__hint {
  font-weight: 400;
  font-size: 12.5px;
  line-height: 18px;
  opacity: 0.9;
}
</style>
