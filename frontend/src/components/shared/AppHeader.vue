<!-- src/components/shared/AppHeader.vue -->
<!-- El QHeader lleva el degradado corporativo obligatorio
     (.pd-gradient-header, definido en app.scss) y no conmuta con el
     tema: es identidad de marca. Solo cambia con $q.dark el contenido
     del area de pagina, via las custom properties --pd-*. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';

import ThemeToggle from '@components/shared/ThemeToggle.vue';
import { useSessionStore } from '@stores/session.store';

import { deriveDisplayName } from '@/utils/user-display';

interface AppHeaderProps {
  breadcrumb?: string;
}

withDefaults(defineProps<AppHeaderProps>(), {
  breadcrumb: '',
});

defineEmits<{ 'toggle-drawer': [] }>();

const router = useRouter();
const sessionStore = useSessionStore();

const userEmail = computed(() => sessionStore.user?.email ?? '');

/** Iniciales derivadas del correo; sin sesion se mantiene el marcador neutro. */
const userInitials = computed(() => {
  if (!userEmail.value) return 'AU';

  return deriveDisplayName(userEmail.value)
    .split(' ')
    .map((part) => part.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase();
});

const onLogout = async (): Promise<void> => {
  await sessionStore.logout();
  await router.replace('/login');
};
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

      <q-avatar size="30px" class="pd-header-avatar cursor-pointer">
        {{ userInitials }}

        <q-menu anchor="bottom right" self="top right">
          <q-list class="pd-menu">
            <q-item v-if="userEmail" class="pd-menu__identity">
              <q-item-section>
                <q-item-label class="pd-label">{{ userEmail }}</q-item-label>
                <q-item-label caption class="pd-text-secondary">
                  {{ sessionStore.user?.role }}
                </q-item-label>
              </q-item-section>
            </q-item>

            <q-separator />

            <q-item clickable v-close-popup @click="onLogout">
              <q-item-section avatar>
                <q-icon name="logout" size="18px" />
              </q-item-section>
              <q-item-section>Cerrar sesion</q-item-section>
            </q-item>
          </q-list>
        </q-menu>
      </q-avatar>
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

// El menu cuelga del header pero se despliega sobre el area de contenido,
// asi que consume los tokens --pd-* del tema activo, no los del shell.
.pd-menu {
  background: var(--pd-card-bg);
  color: var(--pd-text-primary);
  min-width: 200px;
}

.pd-menu__identity {
  background: var(--pd-surface-muted);
}
</style>
