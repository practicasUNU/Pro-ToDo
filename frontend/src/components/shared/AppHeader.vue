<!-- src/components/shared/AppHeader.vue -->
<!-- QHeader se queda oscuro ($dark) en ambos modos a propósito —
     es la decisión de marca ya visible en los wireframes originales
     del proyecto. Lo único que cambia con el tema es el contenido,
     vía las custom properties de app.scss. -->
<script setup lang="ts">
import ThemeToggle from '@components/shared/ThemeToggle.vue';

interface AppHeaderProps {
  breadcrumb?: string;
  userInitials?: string;
}

withDefaults(defineProps<AppHeaderProps>(), {
  breadcrumb: '',
  userInitials: 'AU',
});

defineEmits<{ 'toggle-drawer': [] }>();
</script>

<template>
  <q-header class="bg-dark text-white" :height-hint="60">
    <q-toolbar class="pd-toolbar">
      <q-btn flat dense round icon="menu" @click="$emit('toggle-drawer')" />

      <q-avatar size="26px" class="q-ml-sm">
        <img src="@/assets/unuware-logo-isotype.svg" alt="UNUWARE" />
      </q-avatar>
      <q-toolbar-title class="text-weight-bold" style="letter-spacing: 1.5px; font-size: 14px">
        UNUWARE
      </q-toolbar-title>

      <q-separator dark vertical inset class="q-mx-md" />
      <div class="pd-shell-text-secondary">{{ breadcrumb }}</div>

      <q-space />

      <theme-toggle class="q-mr-sm" />

      <q-avatar size="30px" color="grey-9" text-color="white" class="text-caption">
        {{ userInitials }}
      </q-avatar>
    </q-toolbar>
  </q-header>
</template>
