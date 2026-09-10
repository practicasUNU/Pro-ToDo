<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';

import AppHeader from '@components/shared/AppHeader.vue';

import { useSessionMonitor } from '@/composables/useSessionMonitor';

// Titulo de seccion mostrado en la cabecera, derivado de la ruta activa.
const ROUTE_BREADCRUMBS: Record<string, string> = {
  '/': 'Inicio',
  '/users': 'Gestion de Usuarios',
  '/ip-whitelist': 'Lista Blanca de IPs',
  '/templates': 'Catalogo de Plantillas',
  '/flujos': 'Flujos',
  '/flujos/nuevo': 'Nuevo Flujo',
  '/plantillas-flujo': 'Plantillas de Flujo',
  '/nodos/config-sandbox': 'Banco de Pruebas de Nodos',
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

        <q-item to="/ip-whitelist" clickable v-ripple>
          <q-item-section avatar>
            <q-icon name="shield" size="20px" />
          </q-item-section>
          <q-item-section class="pd-nav">Lista Blanca de IPs</q-item-section>
        </q-item>

        <q-item to="/templates" clickable v-ripple>
          <q-item-section avatar>
            <q-icon name="description" size="20px" />
          </q-item-section>
          <q-item-section class="pd-nav">Plantillas-HTML</q-item-section>
        </q-item>

        <!-- El catalogo de flujos instanciados. Va ANTES del asistente porque
             ese es el orden natural: primero se ve lo que hay, luego se crea.
             El boton "Nuevo Flujo" de esta misma vista sigue existiendo; la
             entrada del menu es el atajo para quien ya sabe que va a crear.

             `exact` es OBLIGATORIO desde que el asistente tiene su propia
             entrada: sin el, vue-router marca activa esta tambien en
             /flujos/nuevo y /flujos/:id/editar, y se resaltarian dos items del
             menu a la vez. -->
        <q-item to="/flujos" exact clickable v-ripple>
          <q-item-section avatar>
            <q-icon name="auto_awesome_motion" size="20px" />
          </q-item-section>
          <q-item-section class="pd-nav">Flujos</q-item-section>
        </q-item>

        <!-- Asistente de alta. Aqui `exact` no hace falta: /flujos/nuevo no es
             padre de ninguna otra ruta, asi que solo casa consigo misma. -->
        <q-item to="/flujos/nuevo" clickable v-ripple>
          <q-item-section avatar>
            <q-icon name="add_circle_outline" size="20px" />
          </q-item-section>
          <q-item-section class="pd-nav">Nuevo Flujo</q-item-section>
        </q-item>

        <q-item to="/plantillas-flujo" clickable v-ripple>
          <q-item-section avatar>
            <q-icon name="schema" size="20px" />
          </q-item-section>
          <q-item-section class="pd-nav">Plantillas de Flujo</q-item-section>
        </q-item>

        <q-item to="/nodos/config-sandbox" clickable v-ripple>
          <q-item-section avatar>
            <q-icon name="account_tree" size="20px" />
          </q-item-section>
          <q-item-section class="pd-nav">Nodos</q-item-section>
        </q-item>
      </q-list>
    </q-drawer>

    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>
