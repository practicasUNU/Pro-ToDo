<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { useNodeCatalogStore } from '@stores/node-catalog.store';

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

const catalogStore = useNodeCatalogStore();

/** Texto del buscador. Estado local de la vista: muere con el selector. */
const searchQuery = ref('');

/** Si el operador esta filtrando; distingue "sin coincidencias" de "sin plantillas". */
const isSearching = computed<boolean>(() => searchQuery.value.trim().length > 0);

/**
 * Plantillas que casan con la busqueda, sin distinguir mayusculas.
 *
 * Se busca en el nombre, en la descripcion —que lleva el slug `[wf-…]` del
 * maestro, el unico "codigo" que tiene una plantilla de flujo— y en los rotulos
 * de sus nodos, para encontrar "todas las que publican en Acens" sin recordar
 * como se llaman. Filtrar no altera `props.templates`: solo cambia lo que se
 * pinta.
 */
const filteredTemplates = computed<WorkflowTemplateSummary[]>(() => {
  const query = searchQuery.value.trim().toLowerCase();

  if (query.length === 0) return props.templates;

  return props.templates.filter(
    (template) =>
      template.name.toLowerCase().includes(query) ||
      (template.description?.toLowerCase().includes(query) ?? false) ||
      template.topology.some((step) =>
        NODE_TYPE_LABELS[step.nodeType].toLowerCase().includes(query),
      ),
  );
});

const clearSearch = (): void => {
  searchQuery.value = '';
};

// El catalogo hace falta para saber que tipos sabe ejecutar el motor. Se pide
// aqui y no en la pagina porque es este componente quien lo necesita, y la
// llamada es idempotente: `fetchCatalog` no repite la peticion si ya hay datos.
onMounted(() => {
  void catalogStore.fetchCatalog();
});

/**
 * Tipos de la plantilla que el motor NO sabe ejecutar.
 *
 * Una plantilla puede haberse creado cuando el catalogo marcaba como
 * implementados tipos que no lo estaban. Instanciarla llevaba al asistente a un
 * callejon sin salida: los pasos de esos nodos no se pueden validar nunca y el
 * guardado quedaba bloqueado sin explicacion.
 */
const unsupportedTypes = (template: WorkflowTemplateSummary): string[] => [
  ...new Set(
    template.topology
      .filter((step) => !catalogStore.isNodeTypeImplemented(step.nodeType))
      .map((step) => NODE_TYPE_LABELS[step.nodeType]),
  ),
];

/**
 * Elige la plantilla, salvo que contenga nodos no ejecutables.
 *
 * La guarda esta aqui y no solo en el `:disable` del boton porque la tarjeta
 * entera es clicable: sin ella se podria entrar al asistente por el borde de la
 * tarjeta esquivando el boton deshabilitado.
 */
const onSelect = (template: WorkflowTemplateSummary): void => {
  if (unsupportedTypes(template).length > 0) return;

  emit('select', template.id);
};

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

    <template v-else>
      <!-- Buscador Poka-Yoke: solo filtra lo que ya existe, no crea nada. -->
      <q-input
        v-model="searchQuery"
        class="pd-search-input pd-template-search q-mb-md"
        outlined
        dense
        placeholder="Buscar plantilla por nombre, código o nodo"
        aria-label="Buscar plantilla"
        data-test="template-search"
      >
        <template #prepend>
          <q-icon name="search" />
        </template>
        <template #append>
          <q-btn
            v-if="searchQuery"
            flat
            round
            dense
            icon="close"
            aria-label="Limpiar búsqueda"
            data-test="template-search-clear"
            @click="clearSearch"
          />
        </template>
      </q-input>

      <div
        v-if="isSearching && filteredTemplates.length === 0"
        class="pd-card q-pa-lg text-center"
        data-test="template-search-empty"
      >
        <span class="pd-icon-circle q-mb-sm">
          <q-icon name="search_off" size="20px" class="pd-empty-icon" />
        </span>
        <div class="pd-h2">Ninguna plantilla coincide</div>
        <p class="pd-search-empty-text q-mt-sm q-mb-md">
          No hay plantillas cuyo nombre, código o nodos contengan «{{ searchQuery.trim() }}».
        </p>
        <q-btn
          class="pd-btn-secondary"
          flat
          no-caps
          label="Limpiar búsqueda"
          data-test="template-search-reset"
          @click="clearSearch"
        />
      </div>

      <div v-else class="row q-col-gutter-md">
        <div
          v-for="template in filteredTemplates"
          :key="template.id"
          class="col-12 col-md-6 col-lg-4"
        >
          <q-card
            class="pd-card pd-pipeline-card"
            :class="{ 'pd-pipeline-card--blocked': unsupportedTypes(template).length > 0 }"
            flat
            @click="onSelect(template)"
          >
            <div class="pd-pipeline-card__banner">
              <q-icon name="account_tree" size="22px" />
            </div>

            <q-card-section>
              <div class="row items-center no-wrap q-gutter-xs">
                <div class="pd-h2 ellipsis">{{ template.name }}</div>
                <q-space />
                <q-badge
                  class="pd-badge"
                  :class="
                    unsupportedTypes(template).length > 0
                      ? 'pd-badge--inactive'
                      : 'pd-badge--active'
                  "
                >
                  {{
                    unsupportedTypes(template).length > 0
                      ? 'No disponible'
                      : `${template.topology.length} nodos`
                  }}
                </q-badge>
              </div>

              <p class="pd-subtitle q-mt-xs q-mb-sm">
                {{ template.description ?? 'Sin descripcion' }}
              </p>

              <div class="pd-mono pd-pipeline-card__steps">{{ previewSteps(template) }}</div>

              <!-- Se bloquea la tarjeta en vez de ocultarla: una plantilla que el
                 operador creo no debe desaparecer sin decir por que. -->
              <p
                v-if="unsupportedTypes(template).length > 0"
                class="pd-subtitle pd-pipeline-card__blocked q-mt-sm q-mb-none"
              >
                Contiene nodos sin estrategia en el motor:
                {{ unsupportedTypes(template).join(', ') }}. Editala en Plantillas de Flujo para
                poder usarla.
              </p>
            </q-card-section>

            <q-card-actions align="right" class="q-px-md q-pb-md q-pt-none">
              <q-btn
                class="pd-btn-primary"
                unelevated
                no-caps
                label="Configurar"
                icon-right="north_east"
                :disable="unsupportedTypes(template).length > 0"
                @click.stop="onSelect(template)"
              />
            </q-card-actions>
          </q-card>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped lang="scss">
.pd-empty-icon {
  color: var(--pd-primary);
}

// Ocupa el ancho de la rejilla (en las tablas va en una esquina) y se apoya en
// la superficie secundaria: es un panel de filtrado, no un campo de formulario.
.pd-template-search {
  width: 100%;
  max-width: 30rem;

  :deep(.q-field__control) {
    background: var(--pd-surface-muted);
  }
}

.pd-search-empty-text {
  color: var(--pd-text-secondary);
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

  &__blocked {
    color: var(--pd-negative);
  }

  &--blocked {
    cursor: not-allowed;

    &:hover {
      border-color: var(--pd-border);
    }
  }

  .q-card__section {
    flex: 1;
  }
}
</style>
