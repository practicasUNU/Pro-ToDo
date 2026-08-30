<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useQuasar } from 'quasar';
import { useRoute, useRouter } from 'vue-router';

import OtpCodeInput from '@components/session/OtpCodeInput.vue';
import ThemeToggle from '@components/shared/ThemeToggle.vue';
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
      <!-- Lado izquierdo: identidad institucional y unico lienzo decorativo de
           la vista (halos, reticula de puntos e hexagonos 3D). El lado del
           formulario queda limpio, sobre el fondo plano del token. -->
      <div class="col-12 col-md-6 pd-login-brand">
        <!-- Capa decorativa 3D: 15 hexagonos en profundidad sobre el patron del
             panel. `aria-hidden` + `pointer-events: none` en el scoped: es
             adorno, no debe llegar al lector de pantalla ni robar clics.
             `--hex-index` viaja como custom property para desfasar la animacion
             sin generar 15 clases de delay. -->
        <div class="pd-login-bg" aria-hidden="true">
          <div
            v-for="index in 15"
            :key="index"
            class="hex-wrapper"
            :style="{ '--hex-index': index }"
          >
            <svg class="hex" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
              <polygon
                points="50,3 91,26.5 91,73.5 50,97 9,73.5 9,26.5"
                fill="var(--pd-primary-light)"
                stroke="var(--pd-accent)"
                stroke-width="2"
                stroke-linejoin="round"
              />
              <circle cx="50" cy="50" r="6" fill="var(--pd-accent)" />
            </svg>
          </div>
        </div>

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

            <!-- Mismo componente que el header, en su variante de contenido: el
                 login queda fuera del shell, sobre la tarjeta del tema activo. -->
            <theme-toggle />
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
// El area de pagina se queda con el fondo plano del token: toda la decoracion
// (halos, puntos e hexagonos) vive ahora en el panel de marca.
.pd-login-page {
  background-color: var(--pd-page-bg);
}

// ---------------------------------------------------------------------------
// Fondo animado tridimensional (hexagonos)
// ---------------------------------------------------------------------------
// `perspective` vive aqui, en el ancestro comun: es la unica forma de que los
// 15 hijos compartan el mismo punto de fuga y se lean como una escena y no como
// 15 cajas 3D independientes. `overflow: hidden` recorta el translateZ positivo
// para que ningun hexagono genere scroll horizontal, y `pointer-events: none`
// deja pasar el foco y los clics al formulario que va por encima.
.pd-login-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  perspective: 1000px;
  transform-style: preserve-3d;
}

// El wrapper es quien se anima; el SVG solo escala. Separar ambos permite que
// `preserve-3d` propague la profundidad al glifo sin que el rasterizado del SVG
// se recalcule en cada frame.
.hex-wrapper {
  position: absolute;
  transform-style: preserve-3d;
  // El desfase se lee de la variable inyectada por el v-for: un unico bloque
  // de CSS cubre los 15 elementos.
  animation: pd-hex-drift 20s ease-in-out infinite;
  animation-delay: calc(var(--hex-index) * 0.4s);
  // Aisla cada hexagono en su propia capa de composicion: la animacion corre
  // en el hilo del compositor y no dispara repintados del formulario.
  will-change: transform;
}

.hex {
  display: block;
  width: 100%;
  height: 100%;
  // Los colores del trazo y el relleno son tokens declarados en el SVG del
  // template (regla §2: cero hexadecimales en el componente). Aqui solo se
  // rebaja el relleno para que el hexagono se lea como marca de agua y el
  // contorno --pd-accent siga siendo el elemento dominante.
  fill-opacity: 0.14;
}

// Posicion, escala, ritmo y opacidad se resuelven en tiempo de compilacion:
// `random()` de Sass corre en el build, asi que el resultado es una constelacion
// fija (estable entre recargas) y no un calculo por frame en el cliente.
@for $i from 1 through 15 {
  .hex-wrapper:nth-child(#{$i}) {
    $size: 34px + random(70);

    // Se multiplica por la unidad en vez de interpolar: `#{random(92)}%` emite
    // `44 %` (con espacio), que es un valor invalido y el navegador descarta.
    top: random(92) * 1%;
    left: random(92) * 1%;
    width: $size;
    height: $size;
    // Duracion dispar por elemento: con una unica duracion los 15 hexagonos
    // volverian a sincronizarse aunque arranquen desfasados.
    animation-duration: (16 + random(16)) * 1s;
    opacity: (5 + random(13)) * 0.01;

    @if $i % 3 == 0 {
      animation-direction: alternate-reverse;
    }
  }
}

// Rotacion en los tres ejes + vaiven en Z: el translateZ es lo que produce la
// sensacion de acercamiento/alejamiento respecto al `perspective` del padre.
@keyframes pd-hex-drift {
  0% {
    transform: translateZ(-280px) rotateX(0deg) rotateY(0deg) rotate(0deg);
  }

  50% {
    transform: translateZ(120px) rotateX(180deg) rotateY(140deg) rotate(12deg);
  }

  100% {
    transform: translateZ(-280px) rotateX(360deg) rotateY(360deg) rotate(0deg);
  }
}

// Accesibilidad: quien pide menos movimiento conserva la composicion estatica
// (los hexagonos siguen visibles), no la animacion.
@media (prefers-reduced-motion: reduce) {
  .hex-wrapper {
    animation: none;
  }
}

.pd-login-row {
  min-height: 100vh;
}

// Panel de marca: superficie subordinada + patron decorativo. Dos halos radiales
// en esquinas opuestas y una reticula de puntos, todo derivado de tokens.
// `color-mix` es lo que permite dar opacidad a un token sin quemar el
// hexadecimal, que es lo que obligaria `rgba()`.
//
// Una sola regla cubre ambos temas: --pd-primary/--pd-primary-light NO conmutan
// (identidad de marca) y --pd-surface-muted SI, asi que el mismo tinte al 15% se
// lee como azul palido sobre #E4EAFB y como halo sobre #161A3D. No hace falta un
// bloque body--dark, ni existe body--light con el que hacer simetria.
//
// `position: relative` es el requisito para que .pd-login-bg (absoluto) se ancle
// al panel y no al viewport; `overflow: hidden` recorta los hexagonos que la
// aleatoriedad deje asomando por el borde derecho, que es la frontera con la
// columna del formulario.
//
// Degradacion: `background-color` va en declaracion propia (dos veces: fallback
// opaco y version translucida), de modo que si el motor no entiende `color-mix`
// invalida SOLO `background-image` y el panel se queda con el relleno plano del
// token, nunca sin fondo. No unificar en la forma abreviada `background`, que
// resetearia `background-image` a none.
.pd-login-brand {
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  padding: 48px 40px;
  background-color: var(--pd-surface-muted);
  background-color: color-mix(in srgb, var(--pd-surface-muted) 72%, transparent);
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

// El contenido se eleva sobre la capa decorativa. Sin esto, el z-index: 0 del
// fondo y el orden del DOM lo dejarian por debajo, pero el `will-change` de los
// hexagonos crea contexto de apilamiento y el orden deja de ser fiable.
.pd-login-brand__content {
  position: relative;
  z-index: 1;
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
