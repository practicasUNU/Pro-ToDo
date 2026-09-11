<script setup lang="ts">
import { useDialogPluginComponent } from 'quasar';

import type { StepWarning } from '@stores/flujo-draft.store';

interface Props {
  /** Avisos de los pasos, ya agregados por el borrador. */
  warnings: readonly StepWarning[];
}

defineProps<Props>();

defineEmits([...useDialogPluginComponent.emits]);

const { dialogRef, onDialogHide, onDialogOK, onDialogCancel } = useDialogPluginComponent();
</script>

<template>
  <!-- Sin `persistent` a proposito: cerrar con Esc o pulsando fuera equivale a
       cancelar, que es la opcion segura de las dos. -->
  <q-dialog ref="dialogRef" @hide="onDialogHide">
    <q-card class="pd-dialog-card pd-card--accent pd-accent-grave">
      <q-card-section class="row items-center no-wrap q-gutter-sm">
        <span class="pd-icon-circle">
          <q-icon name="warning_amber" size="20px" class="pd-warning-icon" />
        </span>
        <div class="pd-h2">Hay avisos sin resolver</div>
      </q-card-section>

      <q-card-section class="q-pt-none">
        <p class="pd-subtitle q-mb-sm">
          El flujo se puede guardar, pero conviene que revises esto antes:
        </p>
        <!-- Componente propio y no `$q.dialog({ html: true })`: el nombre del
             paso viene del backend, y renderizarlo como HTML seria inyeccion de
             marcado desde datos. Aqui el `v-for` lo escapa por defecto. -->
        <ul class="pd-warning-list q-mb-none">
          <li v-for="(warning, index) in warnings" :key="index">
            <span class="pd-label">{{ warning.step.name }}</span>
            <span class="pd-subtitle"> — {{ warning.message }}</span>
          </li>
        </ul>
      </q-card-section>

      <q-card-actions align="right" class="q-px-md q-pb-md">
        <q-btn flat no-caps class="pd-btn-secondary" label="Revisar" @click="onDialogCancel" />
        <q-btn
          class="pd-btn-primary"
          unelevated
          no-caps
          label="Guardar igualmente"
          icon-right="north_east"
          @click="onDialogOK"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<style scoped lang="scss">
.pd-warning-icon {
  color: var(--pd-warning);
}

.pd-warning-list {
  padding-left: 18px;
  color: var(--pd-text-secondary);
}
</style>
