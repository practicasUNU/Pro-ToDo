<!-- src/components/shared/ThemeToggle.vue -->
<!-- Conmutador unico de tema (modo claro / oscuro), compartido por el QHeader
     del shell y por la tarjeta del login. Es un QToggle y no un QBtn porque el
     control representa un estado binario persistido, no una accion puntual:
     el propio interruptor comunica en que modo esta la app. -->
<script setup lang="ts">
import { computed } from 'vue';

import { useThemeStore } from '@stores/theme.store';

interface ThemeToggleProps {
  /**
   * `shell` pinta el control con --pd-shell-text (blanco) para el QHeader y el
   * QDrawer, que se mantienen oscuros con independencia del tema (regla §2,
   * Layout). `content` lo deja en el azul de marca para el area de pagina.
   */
  variant?: 'content' | 'shell';
}

withDefaults(defineProps<ThemeToggleProps>(), {
  variant: 'content',
});

// Sin desestructurar: destructurar un store de Pinia rompe la reactividad.
const themeStore = useThemeStore();

/**
 * El v-model escribe a traves del store, no sobre `$q.dark.isActive`: `isActive`
 * es de solo lectura y, ademas, `useThemeStore` es quien persiste la eleccion en
 * localStorage. Asignarlo a mano perderia el modo al recargar.
 */
const isDarkMode = computed<boolean>({
  get: () => themeStore.isDark,
  set: () => themeStore.toggleTheme(),
});
</script>

<template>
  <q-toggle
    v-model="isDarkMode"
    dense
    checked-icon="dark_mode"
    unchecked-icon="light_mode"
    color="primary"
    :class="{ 'pd-theme-toggle--shell': variant === 'shell' }"
    aria-label="Alternar modo claro y oscuro"
    data-testid="theme-toggle"
  >
    <q-tooltip anchor="bottom middle" self="top middle">
      {{ isDarkMode ? 'Modo claro' : 'Modo oscuro' }}
    </q-tooltip>
  </q-toggle>
</template>

<style scoped lang="scss">
// Sobre el degradado corporativo el azul de marca desaparece, asi que la
// variante `shell` fuerza el blanco del shell en ambos estados. Quasar pinta
// pulgar y riel con `currentColor` heredado de `.q-toggle__inner`, de modo que
// basta reasignar `color` ahi: un unico punto, sin tocar cada subelemento.
.pd-theme-toggle--shell :deep(.q-toggle__inner) {
  color: var(--pd-shell-text);
}
</style>
