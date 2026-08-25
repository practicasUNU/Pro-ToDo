<script setup lang="ts">
// Familias tipograficas self-hosted (briefing 1.2). Se importan aqui
// y no en app.scss porque Vite solo empaqueta los .woff2 cuando el CSS
// entra por un import de JS/TS. Sin CDN externo.
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
</script>

<template>
  <router-view />
</template>
