<script setup lang="ts">
import { NODE_TYPE_LABELS } from '@/types/pipeline';

import type { PipelineSummary } from '@/types/pipeline';

interface Props {
  pipelines: PipelineSummary[];
  isLoading: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  select: [pipelineId: string];
}>();

/**
 * Resumen de la cadena de nodos, para que el operador sepa que va a configurar
 * antes de entrar al asistente.
 *
 * Se recorta a los tres primeros: la tarjeta es un adelanto, no el diagrama de
 * topologia (que es la vista `/flujos/:id`, de solo lectura).
 */
const previewSteps = (pipeline: PipelineSummary): string =>
  pipeline.topology
    .slice(0, 3)
    .map((step) => NODE_TYPE_LABELS[step.nodeType])
    .join(' → ') + (pipeline.topology.length > 3 ? ' → …' : '');
</script>

<template>
  <section>
    <h1 class="pd-h1">Nuevo flujo</h1>
    <p class="pd-subtitle q-mb-lg">
      Elige el pipeline del que partir. Cada uno define su propia secuencia de nodos y el asistente
      te guiara paso a paso para configurarlos.
    </p>

    <div v-if="props.isLoading" class="row justify-center q-py-xl">
      <q-spinner size="32px" color="primary" />
    </div>

    <!-- Estado vacio explicito: sin esto, un catalogo sin flujos configurados
         dejaria la vista en blanco y parecería un fallo de carga. -->
    <div v-else-if="props.pipelines.length === 0" class="pd-card q-pa-lg text-center">
      <span class="pd-icon-circle q-mb-sm">
        <q-icon name="account_tree" size="20px" class="pd-empty-icon" />
      </span>
      <div class="pd-h2">No hay pipelines configurados</div>
      <p class="pd-subtitle q-mt-sm q-mb-none">
        Solo aparecen aqui los flujos que ya tienen una configuracion de pipeline guardada.
      </p>
    </div>

    <div v-else class="row q-col-gutter-md">
      <div v-for="pipeline in props.pipelines" :key="pipeline.id" class="col-12 col-md-6 col-lg-4">
        <q-card class="pd-card pd-pipeline-card" flat @click="emit('select', pipeline.id)">
          <div class="pd-pipeline-card__banner">
            <q-icon name="account_tree" size="22px" />
          </div>

          <q-card-section>
            <div class="row items-center no-wrap q-gutter-xs">
              <div class="pd-h2 ellipsis">{{ pipeline.name }}</div>
              <q-space />
              <q-badge
                class="pd-badge"
                :class="pipeline.active ? 'pd-badge--active' : 'pd-badge--inactive'"
              >
                {{ pipeline.active ? 'Activo' : 'Inactivo' }}
              </q-badge>
            </div>

            <p class="pd-subtitle q-mt-xs q-mb-sm">
              {{ pipeline.description ?? 'Sin descripcion' }}
            </p>

            <div class="pd-mono pd-pipeline-card__steps">{{ previewSteps(pipeline) }}</div>
          </q-card-section>

          <q-card-actions align="right" class="q-px-md q-pb-md q-pt-none">
            <q-btn
              class="pd-btn-primary"
              unelevated
              no-caps
              label="Configurar"
              icon-right="north_east"
              @click.stop="emit('select', pipeline.id)"
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
