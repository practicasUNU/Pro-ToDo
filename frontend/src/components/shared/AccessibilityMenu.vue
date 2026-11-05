<!-- src/components/shared/AccessibilityMenu.vue -->
<!-- Menu de accesibilidad del encabezado (WCAG 2.1): paleta para daltonismo o
     alto contraste, escala tipografica, espaciado de texto y objetivos tactiles.
     Solo consume `useAccessibilityStore`, que aplica cada cambio sobre <html>. -->
<script setup lang="ts">
import { computed } from 'vue';

import { useAccessibilityStore } from '@stores/accessibility.store';

import ThemeToggle from '@components/shared/ThemeToggle.vue';

import {
  AccessibilityPalette,
  FONT_SCALES,
  PALETTE_LABELS,
  TextSpacing,
} from '@/types/accessibility';

import type { FontScale } from '@/types/accessibility';

interface Props {
  /**
   * Muestra el conmutador de tema dentro del menu. Lo activa la cabecera en
   * movil, donde no cabe a su lado con los objetivos de 44px.
   */
  includeThemeToggle?: boolean;
}

withDefaults(defineProps<Props>(), { includeThemeToggle: false });

const store = useAccessibilityStore();

const PALETTE_OPTIONS = Object.values(AccessibilityPalette).map((value) => ({
  label: PALETTE_LABELS[value],
  value,
}));

const FONT_SCALE_OPTIONS = FONT_SCALES.map((value) => ({
  label: `${Math.round(value * 100)} %`,
  value,
}));

const wideSpacing = computed<boolean>({
  get: () => store.textSpacing === TextSpacing.WIDE,
  set: (value) => store.setTextSpacing(value ? TextSpacing.WIDE : TextSpacing.NORMAL),
});
</script>

<template>
  <q-btn
    flat
    round
    icon="accessibility_new"
    class="pd-a11y-trigger"
    aria-label="Opciones de accesibilidad"
    data-testid="a11y-menu-trigger"
  >
    <q-tooltip>Accesibilidad</q-tooltip>

    <!-- Acotado al viewport: con la escala de texto al maximo y los objetivos
         de 44px el menu superaba el alto de un movil y no se podia cerrar. -->
    <q-menu
      anchor="bottom right"
      self="top right"
      max-width="calc(100vw - 32px)"
      max-height="calc(100vh - 80px)"
    >
      <div class="pd-a11y-menu q-pa-md" role="group" aria-label="Opciones de accesibilidad">
        <div class="pd-h2 q-mb-sm">Accesibilidad</div>

        <div class="pd-label q-mb-xs" id="a11y-palette-label">Paleta de color</div>
        <q-option-group
          :model-value="store.palette"
          :options="PALETTE_OPTIONS"
          type="radio"
          dense
          aria-labelledby="a11y-palette-label"
          data-testid="a11y-palette"
          @update:model-value="store.setPalette($event as AccessibilityPalette)"
        />

        <q-separator class="q-my-sm" />

        <div class="pd-label q-mb-xs" id="a11y-font-label">Tamano del texto</div>
        <q-btn-toggle
          :model-value="store.fontScale"
          :options="FONT_SCALE_OPTIONS"
          no-caps
          unelevated
          spread
          toggle-color="primary"
          aria-labelledby="a11y-font-label"
          data-testid="a11y-font-scale"
          @update:model-value="store.setFontScale($event as FontScale)"
        />

        <q-separator class="q-my-sm" />

        <q-toggle
          v-model="wideSpacing"
          label="Espaciado de texto amplio"
          data-testid="a11y-text-spacing"
        />
        <q-toggle
          :model-value="store.largeTargets"
          label="Objetivos tactiles amplios (44 px)"
          data-testid="a11y-large-targets"
          @update:model-value="store.setLargeTargets($event)"
        />

        <template v-if="includeThemeToggle">
          <q-separator class="q-my-sm" />
          <div class="row items-center justify-between" data-testid="a11y-theme-row">
            <span class="pd-label">Modo oscuro</span>
            <theme-toggle />
          </div>
        </template>

        <q-btn
          flat
          no-caps
          class="pd-btn-secondary full-width q-mt-sm"
          icon="restart_alt"
          label="Restablecer"
          data-testid="a11y-reset"
          @click="store.reset()"
        />
      </div>
    </q-menu>
  </q-btn>
</template>

<style scoped lang="scss">
// Sobre el degradado del shell: tokens --pd-shell-*. El menu se despliega
// sobre el area de contenido y usa los --pd-* del tema activo.
.pd-a11y-trigger {
  color: var(--pd-shell-text);
}

.pd-a11y-menu {
  background: var(--pd-card-bg);
  color: var(--pd-text-primary);
  // `min()` y no 280px a secas: en un movil de 320px el menu, con su margen,
  // se salia por la izquierda de la pantalla.
  min-width: min(280px, calc(100vw - 32px));
}
</style>
