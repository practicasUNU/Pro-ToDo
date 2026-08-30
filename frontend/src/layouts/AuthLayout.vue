<script setup lang="ts">
// Layout desnudo para las rutas de autenticacion: sin QHeader ni QDrawer.
// La navegacion no tiene sentido antes de tener sesion, y mostrar el shell
// corporativo sugeriria que ya se esta dentro de la aplicacion.
</script>

<template>
  <q-layout view="hHh lpR fFf">
    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>
