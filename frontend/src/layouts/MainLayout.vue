<script setup lang="ts">
import { ref } from 'vue';

import AppHeader from '@components/shared/AppHeader.vue';

const leftDrawerOpen = ref(false);

const toggleLeftDrawer = (): void => {
  leftDrawerOpen.value = !leftDrawerOpen.value;
};
</script>

<template>
  <q-layout view="lHh Lpr lFf">
    <!-- Header y drawer permanecen oscuros en ambos temas por identidad de marca -->
    <app-header @toggle-drawer="toggleLeftDrawer" />

    <!-- 220px segun briefing 2.1 -->
    <q-drawer
      v-model="leftDrawerOpen"
      show-if-above
      bordered
      :width="220"
      class="pd-drawer bg-dark text-white"
    >
      <q-list>
        <q-item-label header class="pd-label">Navegacion</q-item-label>

        <q-item to="/" exact clickable v-ripple>
          <q-item-section avatar>
            <q-icon name="home" />
          </q-item-section>
          <q-item-section>Inicio</q-item-section>
        </q-item>

        <q-item to="/users" clickable v-ripple>
          <q-item-section avatar>
            <q-icon name="group" />
          </q-item-section>
          <q-item-section>Usuarios</q-item-section>
        </q-item>
      </q-list>
    </q-drawer>

    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>
