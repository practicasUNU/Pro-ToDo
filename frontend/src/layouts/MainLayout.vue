<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';

import AppHeader from '@components/shared/AppHeader.vue';

import { useSessionMonitor } from '@/composables/useSessionMonitor';

// Titulo de seccion mostrado en la cabecera, derivado de la ruta activa.
const ROUTE_BREADCRUMBS: Record<string, string> = {
  '/': 'Inicio',
  '/users': 'Gestion de Usuarios',
};

const route = useRoute();

// Vigila la caducidad del JWT. Se engancha aqui porque este layout envuelve
// todas las rutas autenticadas y se desmonta al salir a /login.
useSessionMonitor();

const leftDrawerOpen = ref(false);

const breadcrumb = computed(() => ROUTE_BREADCRUMBS[route.path] ?? '');

const toggleLeftDrawer = (): void => {
  leftDrawerOpen.value = !leftDrawerOpen.value;
};
</script>

<template>
  <q-layout view="lHh Lpr lFf">
    <!-- El header lleva el degradado corporativo y el drawer se queda navy:
         ambos son identidad de marca y no conmutan con $q.dark -->
    <app-header :breadcrumb="breadcrumb" @toggle-drawer="toggleLeftDrawer" />

    <!-- 220px segun regla §2 (Layout) -->
    <q-drawer v-model="leftDrawerOpen" show-if-above bordered :width="220" class="pd-drawer">
      <q-list>
        <q-item-label header>Navegacion</q-item-label>

        <q-item to="/" exact clickable v-ripple>
          <q-item-section avatar>
            <q-icon name="home" size="20px" />
          </q-item-section>
          <q-item-section class="pd-nav">Inicio</q-item-section>
        </q-item>

        <q-item to="/users" clickable v-ripple>
          <q-item-section avatar>
            <q-icon name="group" size="20px" />
          </q-item-section>
          <q-item-section class="pd-nav">Usuarios</q-item-section>
        </q-item>
      </q-list>
    </q-drawer>

    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>
