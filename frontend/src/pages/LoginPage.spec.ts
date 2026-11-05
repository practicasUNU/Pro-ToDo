// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  QBanner,
  QBtn,
  QCard,
  QCardActions,
  QCardSection,
  QForm,
  QIcon,
  QInput,
  QToggle,
  QTooltip,
  Notify,
  Quasar,
} from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from '@stores/session.store';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/auth.service', () => ({
  requestOtp: vi.fn(),
  verifyOtp: vi.fn(),
  refreshSession: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ replace: vi.fn() }),
}));

const LoginPage = (await import('./LoginPage.vue')).default;

const mountPage = () =>
  mount(LoginPage, {
    global: {
      plugins: [[Quasar, { plugins: { Notify } }]],
      components: {
        QBanner,
        QBtn,
        QCard,
        QCardActions,
        QCardSection,
        QForm,
        QIcon,
        QInput,
        QToggle,
        QTooltip,
      },
      // La pagina se monta fuera de QLayout: QPage exige su inyeccion.
      stubs: { QPage: { template: '<div><slot /></div>' } },
    },
  });

describe('LoginPage', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('1.1 deberia enviar el correo recortado y en minusculas al pedir el codigo', async () => {
    // 1. Arrange 📐: correo pegado con espacios y mayusculas.
    const sessionStore = useSessionStore();
    const requestOtp = vi.spyOn(sessionStore, 'requestOtp').mockResolvedValue(120);
    const wrapper = mountPage();

    await wrapper.findComponent(QInput).vm.$emit('update:modelValue', '  Usuario@UNUWARE.com ');

    // 2. Act ⚙️
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    // 3. Assert 🎯
    expect(requestOtp).toHaveBeenCalledWith('usuario@unuware.com');
  });

  it('1.2 deberia validar el codigo con el mismo correo normalizado', async () => {
    // 1. Arrange 📐: paso 1 superado con un correo sin normalizar.
    const sessionStore = useSessionStore();
    vi.spyOn(sessionStore, 'requestOtp').mockResolvedValue(120);
    const verifyOtp = vi.spyOn(sessionStore, 'verifyOtp').mockResolvedValue();
    const wrapper = mountPage();

    await wrapper.findComponent(QInput).vm.$emit('update:modelValue', ' Usuario@UNUWARE.com');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    // 2. Act ⚙️: las seis casillas completas disparan la validacion.
    const otpInput = wrapper.findComponent({ name: 'OtpCodeInput' });
    await otpInput.vm.$emit('update:modelValue', '123456');
    await otpInput.vm.$emit('complete');
    await flushPromises();

    // 3. Assert 🎯
    expect(verifyOtp).toHaveBeenCalledWith('usuario@unuware.com', '123456');
  });
});
