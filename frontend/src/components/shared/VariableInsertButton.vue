<script setup lang="ts">
import VariableExplorer from '@components/shared/VariableExplorer.vue';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

interface Props {
  /** Namespaces que publican los pasos anteriores del flujo. */
  context: readonly UpstreamNamespace[];

  /** Nombre del campo, para el `aria-label` y el boton de insercion. */
  fieldLabel: string;
}

defineProps<Props>();

const emit = defineEmits<{
  /** Marcador `{{namespace.campo}}` elegido; el anfitrion decide donde va. */
  insert: [token: string];
}>();
</script>

<template>
  <!-- Boton + menu + explorador, el trio que el destino HTTP generico pinta en su
       campo de URL. Se encapsula porque el destino Drupal lo repite en siete
       plantillas, y siete copias divergirian en el rotulo o en el anclaje. No
       escribe en el campo: el anfitrion conoce el cursor, este boton no. -->
  <q-btn
    flat
    dense
    round
    size="sm"
    icon="data_object"
    :aria-label="`Insertar variable en ${fieldLabel}`"
    data-test="variable-insert-button"
  >
    <q-tooltip>Insertar una variable del contexto</q-tooltip>
    <q-menu anchor="bottom right" self="top right" class="pd-card q-pa-md">
      <VariableExplorer
        :context="context"
        :insert-label="`Insertar en ${fieldLabel}`"
        @insert="emit('insert', $event)"
      />
    </q-menu>
  </q-btn>
</template>
