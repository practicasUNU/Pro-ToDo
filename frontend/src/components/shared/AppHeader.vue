<!-- src/components/shared/AppHeader.vue -->
<!-- El QHeader lleva el degradado corporativo obligatorio
     (.pd-gradient-header, definido en app.scss) y no conmuta con el
     tema: es identidad de marca. Solo cambia con $q.dark el contenido
     del area de pagina, via las custom properties --pd-*. -->
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
  <q-header class="pd-gradient-header" :height-hint="60">
    <q-toolbar class="pd-toolbar">
      <q-btn
        flat
        dense
        round
        icon="menu"
        aria-label="Alternar menu"
        @click="$emit('toggle-drawer')"
      />

      <q-avatar size="26px" class="q-ml-sm">
        <img src="@/assets/unuware-logo-isotype.svg" alt="UNUWARE" />
      </q-avatar>
      <q-toolbar-title class="pd-nav">UNUWARE</q-toolbar-title>

      <q-separator vertical inset class="q-mx-md pd-header-separator" />
      <div class="pd-header-breadcrumb">{{ breadcrumb }}</div>

      <q-space />

      <theme-toggle class="q-mr-sm" />

      <q-avatar size="30px" class="pd-header-avatar">{{ userInitials }}</q-avatar>
    </q-toolbar>
  </q-header>
</template>

<style scoped lang="scss">
// Sobre el degradado se consumen los tokens --pd-shell-*; los --pd-text-*
// son del area de contenido y no aplican aqui (regla §2, Layout).
.pd-header-breadcrumb {
  color: var(--pd-shell-text-secondary);
  font-size: 12.5px;
  line-height: 18px;
}

.pd-header-separator {
  background: var(--pd-shell-text-secondary);
  opacity: 0.4;
}

.pd-header-avatar {
  background: var(--pd-panel-solid);
  color: var(--pd-shell-text);
  font-size: 12px;
  font-weight: 700;
}
</style>
