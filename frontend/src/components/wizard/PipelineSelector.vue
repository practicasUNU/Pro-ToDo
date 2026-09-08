<script setup lang="ts">
import { NODE_TYPE_LABELS } from '@/types/pipeline';

import type { WorkflowTemplateSummary } from '@/types/pipeline';

interface Props {
  /**
   * Blueprints disponibles.
   *
   * Son PLANTILLAS y no flujos instanciados: hasta la migracion 010 el selector
   * partia de `flujos`, lo que hacia que el maestro y la instancia fuesen la
   * misma fila.
   */
  templates: WorkflowTemplateSummary[];
  isLoading: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  select: [templateId: string];
}>();

/**
 * Resumen de la cadena de nodos, para que el operador sepa que va a configurar
 * antes de entrar al asistente.
 *
 * Se recorta a los tres primeros: la tarjeta es un adelanto, no el diagrama de
 * topologia (que es la vista `/flujos/:id`, de solo lectura).
 */
const previewSteps = (template: WorkflowTemplateSummary): string =>
  template.topology
    .slice(0, 3)
    .map((step) => NODE_TYPE_LABELS[step.nodeType])
    .join(' → ') + (template.topology.length > 3 ? ' → …' : '');
</script>

<template>
  <section>
    <h1 class="pd-h1">Nuevo flujo</h1>
    <p class="pd-subtitle q-mb-lg">
      Elige la plantilla de la que partir. Cada una define una secuencia de nodos y el asistente te
      guiara paso a paso para configurarlos. Tu flujo se queda con una copia propia: editar la
      plantilla despues no lo altera.
    </p>

    <div v-if="props.isLoading" class="row justify-center q-py-xl">
      <q-spinner size="32px" color="primary" />
    </div>

    <!-- Estado vacio explicito Y CON SALIDA: sin el enlace al catalogo, un
         operador que llega antes de que exista ninguna plantilla se queda sin
         saber que hacer, y la vista en blanco parece un fallo de carga. -->
    <div v-else-if="props.templates.length === 0" class="pd-card q-pa-lg text-center">
      <span class="pd-icon-circle q-mb-sm">
        <q-icon name="account_tree" size="20px" class="pd-empty-icon" />
      </span>
      <div class="pd-h2">No hay plantillas disponibles</div>
      <p class="pd-subtitle q-mt-sm q-mb-md">
        Un flujo se crea siempre a partir de una plantilla. Define la primera en el catalogo de
        plantillas de flujo.
      </p>
      <q-btn
        class="pd-btn-primary"
        unelevated
        no-caps
        label="Ir a Plantillas de Flujo"
        icon-right="north_east"
        to="/plantillas-flujo"
      />
    </div>

    <div v-else class="row q-col-gutter-md">
      <div v-for="template in props.templates" :key="template.id" class="col-12 col-md-6 col-lg-4">
        <q-card class="pd-card pd-pipeline-card" flat @click="emit('select', template.id)">
          <div class="pd-pipeline-card__banner">
            <q-icon name="account_tree" size="22px" />
          </div>

          <q-card-section>
            <div class="row items-center no-wrap q-gutter-xs">
              <div class="pd-h2 ellipsis">{{ template.name }}</div>
              <q-space />
              <q-badge class="pd-badge pd-badge--active">
                {{ template.topology.length }} nodos
              </q-badge>
            </div>

            <p class="pd-subtitle q-mt-xs q-mb-sm">
              {{ template.description ?? 'Sin descripcion' }}
            </p>

            <div class="pd-mono pd-pipeline-card__steps">{{ previewSteps(template) }}</div>
          </q-card-section>

          <q-card-actions align="right" class="q-px-md q-pb-md q-pt-none">
            <q-btn
              class="pd-btn-primary"
              unelevated
              no-caps
              label="Configurar"
              icon-right="north_east"
              @click.stop="emit('select', template.id)"
            />
          </q-card-actions>
        </q-card>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.pd-empty-icon {
  color: var(--pd-primary);
}

.pd-pipeline-card {
  cursor: pointer;
  height: 100%;
  display: flex;
  flex-direction: column;
  transition: border-color 0.2s ease;

  &:hover {
    border-color: var(--pd-accent);
  }

  // Degradado corporativo obligatorio de la cabecera (regla §2).
  &__banner {
    background: var(--pd-gradient);
    color: var(--pd-text-primary);
    padding: 14px 16px;
    display: flex;
    align-items: center;
  }

  &__steps {
    color: var(--pd-text-secondary);
    word-break: break-word;
  }

  .q-card__section {
    flex: 1;
  }
}
</style>
