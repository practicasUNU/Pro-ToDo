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

import { deriveDisplayName, roleDisplayLabel, roleIconName } from '@/utils/user-display';

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

/** Icono del rol activo, mostrado junto al correo en el menu de perfil. */
const roleIcon = computed(() => roleIconName(sessionStore.user?.role));

/** Etiqueta del rol en castellano; sustituye al valor crudo del enum. */
const roleLabel = computed(() => roleDisplayLabel(sessionStore.user?.role));

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

      <!-- Logotipo largo: el PNG es azul corporativo monocromo y se perderia
           sobre el degradado. El filtro lo aplana a negro y lo invierte a
           blanco, el color que exige la regla §2 para el shell, sin necesidad
           de un segundo asset ni de un hexadecimal en el componente. El
           logotipo ya dice "UNUWARE.COM", asi que el q-toolbar-title textual
           desaparece: el <q-space> de abajo es quien empuja el bloque derecho. -->
      <img src="@/assets/unuware-long-logo.png" alt="UNUWARE" class="pd-header-logo q-ml-sm" />

      <q-separator vertical inset class="q-mx-md pd-header-separator" />
      <div class="pd-header-breadcrumb">{{ breadcrumb }}</div>

      <q-space />

      <!-- `variant="shell"` porque el toggle vive sobre el degradado oscuro:
           el azul de marca no contrastaria contra el propio header. -->
      <theme-toggle variant="shell" class="q-mr-sm" />

      <q-avatar size="30px" class="pd-header-avatar cursor-pointer">
        {{ userInitials }}

        <q-menu anchor="bottom right" self="top right">
          <q-list class="pd-menu">
            <q-item v-if="userEmail" class="pd-menu__identity">
              <q-item-section avatar class="pd-menu__role">
                <q-icon :name="roleIcon" size="20px" />
              </q-item-section>
              <q-item-section>
                <q-item-label class="pd-label">{{ userEmail }}</q-item-label>
                <q-item-label caption class="pd-text-secondary">{{ roleLabel }}</q-item-label>
              </q-item-section>
            </q-item>

            <q-separator />

            <!-- El cierre de sesion pasa de q-item a QBtn: q-item no admite
                 `icon-right`, y anidar un boton dentro de un q-item clickable
                 crearia dos objetivos de activacion superpuestos. -->
            <div class="pd-menu__actions">
              <q-btn
                v-close-popup
                class="pd-btn-primary full-width"
                unelevated
                no-caps
                icon="logout"
                icon-right="north_east"
                label="Cerrar sesion"
                @click="onLogout"
              />
            </div>
          </q-list>
        </q-menu>
      </q-avatar>
    </q-toolbar>
  </q-header>
</template>

<style scoped lang="scss">
// Sobre el degradado se consumen los tokens --pd-shell-*; los --pd-text-*
// son del area de contenido y no aplican aqui (regla §2, Layout).

// Alto fijo y ancho automatico: preserva la proporcion 1100x200 del PNG
// (34px de alto -> 187px de ancho) y `flex: 0 0 auto` impide que el toolbar
// lo comprima. `brightness(0)` colapsa los canales de color a negro dejando
// intacto el alfa (y por tanto el antialias del borde); `invert(1)` invierte
// solo color, no alfa: el resultado es un logotipo blanco limpio, sin caja.
.pd-header-logo {
  display: block;
  flex: 0 0 auto;
  height: 34px;
  width: auto;
  filter: brightness(0) invert(1);
}

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

.pd-menu__role {
  min-width: 36px;
  color: var(--pd-accent-text);
}

.pd-menu__actions {
  padding: 8px;
}
</style>
