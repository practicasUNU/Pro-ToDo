<script setup lang="ts">
// Familias tipograficas self-hosted (briefing 1.2). Se importan aqui
// y no en app.scss porque Vite solo empaqueta los .woff2 cuando el CSS
// entra por un import de JS/TS. Sin CDN externo.
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';

// Poppins no tiene eje variable en @fontsource: se importan solo los
// pesos que usa el sistema de diseno (nav 500, .pd-h2 600, .pd-h1 700).
import '@fontsource/poppins/500.css';
import '@fontsource/poppins/600.css';
import '@fontsource/poppins/700.css';
</script>

<template>
  <router-view />
</template>
