<script setup lang="ts">
import { computed } from 'vue';

import { formatDateTime } from '@/utils/date-format';

import type { AuditableData, AuditUser } from '@/types/auditable';

/**
 * Auditoria discreta de una fila maestra (migracion 045).
 *
 * Un unico boton de icono en la columna de acciones que despliega un menu con
 * quien creo y quien modifico por ultima vez el registro, y cuando. La tabla no
 * gana ninguna columna: los cuatro datos solo importan cuando alguien los
 * busca, y en cada fila competirian con lo que de verdad se lee.
 *
 * ACCESIBILIDAD (WCAG 2.1 AA): el boton lleva `aria-label` con el nombre del
 * registro, porque un lector de pantalla recorriendo la tabla oiria "Ver
 * auditoria" diez veces sin saber de que fila. Cada dato se acompana de icono Y
 * texto, nunca solo icono, y la fecha va en `<time datetime>` para que la lean
 * las tecnologias de asistencia con su valor real.
 *
 * Sin estado propio ni llamadas: los datos ya llegan en la fila.
 */
const props = defineProps<{
  /** Campos de auditoria de la fila. */
  audit: AuditableData;
  /** Nombre legible del registro, para el `aria-label` y la cabecera. */
  subject: string;
}>();

/** Texto cuando el cambio no tiene autor registrado. */
const UNKNOWN_AUTHOR = 'Sin registro';

interface AuditRow {
  readonly key: 'created' | 'updated';
  readonly icon: string;
  readonly label: string;
  readonly isoDate: string;
  readonly date: string;
  readonly author: string;
}

const describeAuthor = (user: AuditUser | null): string => user?.email ?? UNKNOWN_AUTHOR;

const rows = computed<AuditRow[]>(() => [
  {
    key: 'created',
    icon: 'add_circle_outline',
    label: 'Creado',
    isoDate: props.audit.createdAt,
    date: formatDateTime(props.audit.createdAt),
    author: describeAuthor(props.audit.createdBy),
  },
  {
    key: 'updated',
    icon: 'edit_note',
    label: 'Última modificación',
    isoDate: props.audit.updatedAt,
    date: formatDateTime(props.audit.updatedAt),
    author: describeAuthor(props.audit.updatedBy),
  },
]);
</script>

<template>
  <q-btn
    class="pd-btn-icon"
    outline
    dense
    size="sm"
    icon="history"
    :aria-label="`Ver auditoría de ${subject}`"
    data-test="audit-trigger"
  >
    <q-tooltip>Ver más · Auditoría</q-tooltip>

    <q-menu anchor="bottom right" self="top right" class="pd-audit-menu">
      <q-list
        dense
        class="pd-audit-list"
        :aria-label="`Auditoría de ${subject}`"
        data-test="audit-details"
      >
        <q-item-label header class="pd-audit-list__header">
          <span class="pd-label">Auditoría</span>
          <span class="pd-audit-list__subject">{{ subject }}</span>
        </q-item-label>

        <q-item v-for="row in rows" :key="row.key" :data-test="`audit-${row.key}`">
          <q-item-section avatar class="pd-audit-list__icon">
            <q-icon :name="row.icon" size="20px" aria-hidden="true" />
          </q-item-section>
          <q-item-section>
            <q-item-label class="pd-label">{{ row.label }}</q-item-label>
            <q-item-label caption class="pd-audit-list__meta">
              <time :datetime="row.isoDate">{{ row.date }}</time>
            </q-item-label>
            <q-item-label caption class="pd-audit-list__meta">
              <q-icon name="person_outline" size="14px" aria-hidden="true" />
              <span>{{ row.author }}</span>
            </q-item-label>
          </q-item-section>
        </q-item>
      </q-list>
    </q-menu>
  </q-btn>
</template>

<style scoped lang="scss">
.pd-audit-list {
  min-width: 260px;
  padding-bottom: 8px;
  background: var(--pd-card-bg);
  color: var(--pd-text-primary);
}

.pd-audit-list__header {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-bottom: 1px solid var(--pd-border);
  margin-bottom: 4px;
}

.pd-audit-list__subject {
  color: var(--pd-text-secondary);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.pd-audit-list__icon {
  color: var(--pd-primary);
}

.pd-audit-list__meta {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--pd-text-secondary);
  overflow-wrap: anywhere;
}
</style>
