<script setup lang="ts">
import { computed } from 'vue';

import StatusBadge from '@components/shared/StatusBadge.vue';

import { computeAuditDiff } from '@/utils/audit-diff';

import type { AuditSnapshot } from '@/types/audit';
import type { AuditDiffKind } from '@/utils/audit-diff';
import type { StatusDisplay } from '@/utils/status-display';

/**
 * Diferencia campo a campo entre dos fotografias de auditoria.
 *
 * Baja hasta las hojas de los objetos anidados: editar el prompt de un nodo OCR
 * se lee como `pipelineSchema.nodes[1].params.customPrompt` con su valor antes y
 * despues, y no como dos volcados JSON que hay que comparar a ojo. Cada fila
 * marca su tipo de cambio con texto e icono, nunca solo con color.
 *
 * Presentacional y sin estado: recibe las dos fotografias del evento.
 */
const props = defineProps<{
  previous: AuditSnapshot | null;
  next: AuditSnapshot | null;
}>();

const KIND_DISPLAY: Readonly<Record<AuditDiffKind, StatusDisplay>> = {
  added: { label: 'Añadido', icon: 'add_circle_outline', badgeClass: 'pd-badge--active' },
  removed: { label: 'Eliminado', icon: 'remove_circle_outline', badgeClass: 'pd-badge--failed' },
  changed: { label: 'Modificado', icon: 'edit_note', badgeClass: 'pd-badge--role' },
};

const entries = computed(() => computeAuditDiff(props.previous, props.next));
</script>

<template>
  <q-markup-table
    v-if="entries.length > 0"
    flat
    dense
    wrap-cells
    class="pd-card pd-table pd-audit-diff"
    data-test="audit-diff"
  >
    <thead>
      <tr>
        <th class="text-left">Campo</th>
        <th class="text-left">Cambio</th>
        <th class="text-left">Antes</th>
        <th class="text-left">Después</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="entry in entries" :key="entry.path" data-test="audit-diff-row">
        <td class="pd-mono pd-audit-diff__path">{{ entry.path }}</td>
        <td><StatusBadge :display="KIND_DISPLAY[entry.kind]" /></td>
        <td class="pd-mono pd-audit-diff__value" data-test="audit-diff-before">
          {{ entry.before }}
        </td>
        <td class="pd-mono pd-audit-diff__value" data-test="audit-diff-after">
          {{ entry.after }}
        </td>
      </tr>
    </tbody>
  </q-markup-table>
  <p v-else class="pd-text-secondary" data-test="audit-diff-empty">
    Sin cambios de datos registrados.
  </p>
</template>

<style scoped lang="scss">
.pd-audit-diff {
  max-height: 420px;
  overflow: auto;
}

.pd-audit-diff__path {
  overflow-wrap: anywhere;
  min-width: 160px;
}

// Prompts y plantillas pueden ocupar parrafos: se conservan los saltos y se
// recortan a una altura legible con scroll propio.
.pd-audit-diff__value {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-width: 320px;
  color: var(--pd-text-secondary);
}
</style>
