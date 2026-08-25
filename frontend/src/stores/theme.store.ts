import { defineStore, acceptHMRUpdate } from 'pinia';
import { Dark } from 'quasar';
import { computed, ref } from 'vue';

// 'auto' delega en la preferencia del sistema operativo (prefers-color-scheme).
// Solo es el valor de arranque: el primer toggle fija un modo explicito.
type ThemeMode = 'light' | 'dark' | 'auto';

const THEME_STORAGE_KEY = 'proto-do:theme-mode';
const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'auto'];

export const useThemeStore = defineStore('theme', () => {
  const mode = ref<ThemeMode>('auto');

  // Dark.isActive es reactivo y, en modo 'auto', Quasar mantiene su propio
  // listener de prefers-color-scheme. Derivarlo evita desincronizarse si el
  // sistema operativo cambia de tema en caliente.
  const isDark = computed<boolean>(() => Dark.isActive);

  // Se lee/escribe con guarda: en modo incognito o con el almacenamiento
  // bloqueado, el acceso a localStorage lanza excepcion.
  const readStoredMode = (): ThemeMode | null => {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      return THEME_MODES.includes(stored as ThemeMode) ? (stored as ThemeMode) : null;
    } catch {
      return null;
    }
  };

  const persistMode = (value: ThemeMode): void => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, value);
    } catch {
      // Sin persistencia disponible: el tema sigue vivo en memoria.
    }
  };

  const applyMode = (value: ThemeMode): void => {
    mode.value = value;
    Dark.set(value === 'auto' ? 'auto' : value === 'dark');
  };

  const initTheme = (): void => {
    applyMode(readStoredMode() ?? 'auto');
  };

  const toggleTheme = (): void => {
    const nextMode: ThemeMode = Dark.isActive ? 'light' : 'dark';
    applyMode(nextMode);
    persistMode(nextMode);
  };

  // Auto-inicializacion: el cuerpo del setup store se ejecuta una unica vez,
  // en el primer useThemeStore() de la app (setup de MainLayout / AppHeader),
  // que ocurre antes del primer pintado -> sin parpadeo de estilos.
  initTheme();

  return { mode, isDark, initTheme, toggleTheme };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useThemeStore, import.meta.hot));
}
