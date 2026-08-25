<!-- src/components/shared/ThemeToggle.vue -->
<!-- El control que aparece en los mockups de Vista 3+4 y Vista 6:
     un QBtn redondo en el QHeader que alterna $q.dark. -->
<script setup lang="ts">
import { useThemeStore } from '@stores/theme.store';

// Sin desestructurar: destructurar un store de Pinia rompe la reactividad.
const themeStore = useThemeStore();
</script>

<template>
  <q-btn
    round
    flat
    dense
    color="white"
    :aria-label="themeStore.isDark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'"
    data-testid="theme-toggle"
    @click="themeStore.toggleTheme"
  >
    <q-icon :name="themeStore.isDark ? 'light_mode' : 'dark_mode'" size="20px" />
    <q-tooltip anchor="bottom middle" self="top middle">
      {{ themeStore.isDark ? 'Modo claro' : 'Modo oscuro' }}
    </q-tooltip>
  </q-btn>
</template>
