<script setup lang="ts">
import { computed } from 'vue';

import { formatDateTime } from '@/utils/date-format';
import { deriveDisplayName } from '@/utils/user-display';

import type { AuditableData } from '@/types/auditable';

/**
 * Celda "Ultima modificacion" de las tablas maestras (migraciones 045 y 058).
 *
 * Complementa a `AuditDetailsMenu`, no lo sustituye: la tabla muestra solo el
 * ultimo cambio —quien y cuando— y el menu sigue guardando el alta completa.
 *
 * ACCESIBILIDAD: el autor va con icono Y texto, y la fecha en `<time datetime>`
 * con su valor ISO real; el correo completo se ofrece en el `title` y en el
 * tooltip, porque el nombre derivado puede coincidir entre dos personas.
 *
 * Sin estado propio ni llamadas: los datos ya llegan en la fila.
 */
const props = defineProps<{
  /** Campos de auditoria de la fila. */
  audit: AuditableData;
}>();

/** Texto cuando el cambio no tiene autor registrado (filas historicas). */
const UNKNOWN_AUTHOR = 'Sin registro';

const author = computed(() =>
  props.audit.updatedBy === null ? UNKNOWN_AUTHOR : deriveDisplayName(props.audit.updatedBy.email),
);

const email = computed(() => props.audit.updatedBy?.email ?? null);
</script>

<template>
  <div class="pd-audit-stamp" data-test="audit-stamp">
    <span class="pd-audit-stamp__author" :title="email ?? undefined">
      <q-icon name="person_outline" size="16px" aria-hidden="true" />
      <span data-test="audit-stamp-author">{{ author }}</span>
      <q-tooltip v-if="email !== null">{{ email }}</q-tooltip>
    </span>
    <time
      class="pd-audit-stamp__date pd-mono"
      :datetime="audit.updatedAt"
      data-test="audit-stamp-date"
    >
      {{ formatDateTime(audit.updatedAt) }}
    </time>
  </div>
</template>

<style scoped lang="scss">
.pd-audit-stamp {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pd-audit-stamp__author {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--pd-text-primary);
}

.pd-audit-stamp__date {
  color: var(--pd-text-secondary);
  font-size: 0.75rem;
}
</style>
