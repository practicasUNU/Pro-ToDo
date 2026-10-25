<!-- src/components/shared/StatusBadge.vue -->
<!-- Badge de estado accesible: icono + texto SIEMPRE, el color solo refuerza
     (WCAG 1.4.1). Recibe la presentacion ya resuelta por un helper de
     `src/utils/` (`describeWorkflowStatus`, `describeSeverity`,
     `describeExecutionState`...), de modo que todas las tablas pintan cada
     estado igual. -->
<script setup lang="ts">
import type { StatusDisplay } from '@/utils/status-display';

interface Props {
  display: StatusDisplay;
}

defineProps<Props>();
</script>

<template>
  <q-badge class="pd-badge pd-status-badge" :class="display.badgeClass">
    <q-icon :name="display.icon" size="1.1em" class="q-mr-xs" aria-hidden="true" />
    <slot>{{ display.label }}</slot>
  </q-badge>
</template>

<style scoped lang="scss">
.pd-status-badge {
  display: inline-flex;
  align-items: center;
}
</style>
