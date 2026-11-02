<script setup lang="ts">
import { computed } from 'vue';

import { useDialogPluginComponent } from 'quasar';

interface Props {
  /** URL absoluta de la pagina publicada (`http_result.published_url`). */
  publishedUrl: string;
  /** Ruta publica de esa pagina (`http_result.exit_page`), si se conoce. */
  exitPage?: string;
  /** Nombre legible del flujo que publico. */
  flowName?: string;
}

const props = defineProps<Props>();

defineEmits([...useDialogPluginComponent.emits]);

const { dialogRef, onDialogHide } = useDialogPluginComponent();

/** Frase de contexto: nombra el flujo cuando el motor lo envio. */
const summary = computed<string>(() =>
  props.flowName
    ? `El flujo «${props.flowName}» publicó el resultado en el portal.`
    : 'El flujo publicó el resultado en el portal.',
);
</script>

<template>
  <!-- `persistent` a proposito: el enlace es el unico sitio donde el operador
       ve la pagina publicada, y un clic fuera o un Esc accidental lo perderia.
       Solo se cierra con la accion explicita. -->
  <q-dialog ref="dialogRef" persistent @hide="onDialogHide">
    <q-card
      class="pd-dialog-card pd-card--accent pd-accent-exitoso"
      data-test="drupal-publish-modal"
    >
      <q-card-section class="row items-center no-wrap q-gutter-sm">
        <span class="pd-icon-circle">
          <q-icon name="task_alt" size="20px" class="pd-success-icon" />
        </span>
        <div class="pd-h2">Publicación Exitosa en Drupal</div>
      </q-card-section>

      <q-card-section class="q-pt-none">
        <p class="pd-subtitle q-mb-sm">{{ summary }}</p>
        <p v-if="exitPage" class="q-mb-md">
          <span class="pd-label">Página afectada: </span>
          <span class="pd-mono" data-test="drupal-publish-exit-page">{{ exitPage }}</span>
        </p>
        <!-- `noopener noreferrer`: la pestaña nueva no recibe `window.opener` ni
             la URL de la aplicación como Referer. -->
        <q-btn
          class="pd-btn-secondary pd-publish-link"
          flat
          no-caps
          :href="publishedUrl"
          target="_blank"
          rel="noopener noreferrer"
          label="Abrir la página publicada"
          icon-right="north_east"
          data-test="drupal-publish-link"
        />
      </q-card-section>

      <q-card-actions align="right" class="q-px-md q-pb-md">
        <q-btn
          label="Entendido y Cerrar"
          class="pd-btn-primary"
          unelevated
          no-caps
          v-close-popup
          data-test="drupal-publish-close"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<style scoped lang="scss">
.pd-success-icon {
  color: var(--pd-positive);
}

.pd-publish-link {
  color: var(--pd-accent-text);
  font-weight: 700;
}
</style>
