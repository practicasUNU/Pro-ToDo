<script setup lang="ts">
import AuditDiffViewer from '@components/audit/AuditDiffViewer.vue';

import { formatSnapshot, labelAuditAction, labelAuditTable } from '@/utils/audit-display';
import { formatDateTime } from '@/utils/date-format';

import type { AuditEvent } from '@/types/audit';

/**
 * Detalle de un evento de auditoria: quien, cuando, desde donde y la
 * diferencia campo a campo entre las dos fotografias, con los objetos anidados
 * aplanados (`AuditDiffViewer`). El JSON completo queda plegado debajo para
 * quien necesite el contexto entero.
 *
 * Solo lectura y sin llamadas: el evento ya llega completo en la fila.
 */
defineProps<{
  modelValue: boolean;
  /** Evento a mostrar; `null` mientras no hay ninguno elegido. */
  event: AuditEvent | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

const close = (): void => {
  emit('update:modelValue', false);
};
</script>

<template>
  <q-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)">
    <q-card class="pd-dialog-card pd-audit-details" data-test="audit-event-details">
      <q-card-section class="row items-center no-wrap q-gutter-sm">
        <span class="pd-icon-circle">
          <q-icon
            name="manage_search"
            size="20px"
            class="pd-audit-details__icon"
            aria-hidden="true"
          />
        </span>
        <div class="col">
          <div class="pd-h2">Detalle del evento</div>
          <div v-if="event" class="pd-text-secondary">
            {{ labelAuditAction(event.action) }} · {{ labelAuditTable(event.affectedTable) }}
          </div>
        </div>
      </q-card-section>

      <q-card-section v-if="event" class="q-pt-none">
        <dl class="pd-audit-details__facts">
          <dt class="pd-label">Fecha</dt>
          <dd>
            <time :datetime="event.createdAt">{{ formatDateTime(event.createdAt) }}</time>
          </dd>
          <dt class="pd-label">Usuario</dt>
          <dd data-test="audit-detail-user">{{ event.userEmail ?? event.userId ?? '—' }}</dd>
          <dt class="pd-label">IP de origen</dt>
          <dd class="pd-mono">{{ event.sourceIp ?? '—' }}</dd>
          <dt class="pd-label">Registro</dt>
          <dd class="pd-mono">{{ event.recordId ?? '—' }}</dd>
        </dl>

        <h3 class="pd-label pd-audit-details__heading">Campos modificados</h3>
        <AuditDiffViewer :previous="event.previousData" :next="event.newData" />

        <q-expansion-item
          dense
          dense-toggle
          icon="data_object"
          label="Ver fotografías completas (JSON)"
          class="pd-audit-details__raw"
          data-test="audit-detail-raw"
        >
          <div class="pd-audit-details__snapshots">
            <section>
              <h3 class="pd-label pd-audit-details__heading">Datos anteriores</h3>
              <pre class="pd-mono pd-audit-details__json" data-test="audit-detail-previous">{{
                formatSnapshot(event.previousData)
              }}</pre>
            </section>
            <section>
              <h3 class="pd-label pd-audit-details__heading">Datos nuevos</h3>
              <pre class="pd-mono pd-audit-details__json" data-test="audit-detail-new">{{
                formatSnapshot(event.newData)
              }}</pre>
            </section>
          </div>
        </q-expansion-item>
      </q-card-section>

      <q-card-actions align="right" class="q-px-md q-pb-md">
        <q-btn
          flat
          no-caps
          label="Cerrar"
          class="pd-btn-secondary"
          data-test="audit-detail-close"
          @click="close"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<style scoped lang="scss">
.pd-audit-details {
  width: 900px;
  max-width: 96vw;
}

.pd-audit-details__icon {
  color: var(--pd-primary);
}

.pd-audit-details__facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 16px;
  margin: 0;

  dd {
    margin: 0;
    color: var(--pd-text-secondary);
    overflow-wrap: anywhere;
  }
}

.pd-audit-details__heading {
  margin: 16px 0 6px;
}

.pd-audit-details__raw {
  margin-top: 12px;
}

.pd-audit-details__snapshots {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
}

.pd-audit-details__json {
  margin: 0;
  max-height: 360px;
  overflow: auto;
  padding: 12px;
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-border);
  color: var(--pd-text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
