<script setup lang="ts">
import { computed, ref } from 'vue';

import { useTemplateMapperStore } from '@stores/nodes/template-mapper.store';

import { configurableNodeTypes, nodeConfigRegistry } from '@components/nodes/node-config-registry';

import { NODE_TYPE_LABELS, NodeType } from '@/types/pipeline';

// Banco de pruebas de la resolucion polimorfica (regla frontend-quasar.md §3.1).
//
// Existe porque el asistente de creacion de flujos (Vista 3+4, PROT-12) aun no
// esta implementado, y sin un anfitrion los configuradores de nodo no se pueden
// ver funcionando. Reproduce lo unico que el asistente hara con ellos: resolver
// el componente por `nodeType` y leer `isConfigValid` para decidir si avanza.

const selectedNodeType = ref<NodeType>(NodeType.MAPEADOR_PLANTILLA);

const templateMapperStore = useTemplateMapperStore();

const nodeTypeOptions = computed(() =>
  configurableNodeTypes.map((nodeType) => ({
    label: NODE_TYPE_LABELS[nodeType],
    value: nodeType,
  })),
);

// Sin `v-if` por tipo: el componente sale del registro (regla §3.1).
const resolvedComponent = computed(() => nodeConfigRegistry[selectedNodeType.value] ?? null);

// Lo que el asistente inspeccionaria del nodo activo. De momento solo hay un
// configurador, asi que se lee su store directamente; cuando haya varios, el
// anfitrion resolvera tambien el store por tipo.
const inspectedState = computed(() =>
  JSON.stringify(
    {
      nodeType: selectedNodeType.value,
      config: templateMapperStore.config,
      isConfigValid: templateMapperStore.isConfigValid,
      requiredVariables: templateMapperStore.requiredVariables,
    },
    null,
    2,
  ),
);
</script>

<template>
  <q-page padding class="pd-page">
    <header class="sandbox-header">
      <div>
        <h1 class="pd-h1">Banco de Pruebas de Nodos</h1>
        <p class="pd-subtitle">
          Verifica la resolucion polimorfica por <span class="pd-mono">nodeType</span> mientras el
          asistente de flujos no existe.
        </p>
      </div>
    </header>

    <div class="sandbox-grid">
      <div>
        <div class="q-mb-md">
          <label class="pd-label" for="sandbox-node-type">Tipo de nodo</label>
          <q-select
            id="sandbox-node-type"
            v-model="selectedNodeType"
            :options="nodeTypeOptions"
            outlined
            dense
            emit-value
            map-options
            class="q-mt-xs"
          />
        </div>

        <component :is="resolvedComponent" v-if="resolvedComponent" node-id="nodo_mapeador_demo" />

        <div v-else class="pd-card q-pa-md pd-text-secondary">
          Este tipo de nodo aun no tiene componente de configuracion registrado.
        </div>
      </div>

      <aside class="pd-card q-pa-md">
        <div class="pd-h2 q-mb-sm">Estado del nodo</div>
        <p class="pd-subtitle q-mb-sm">
          Lo que el asistente leeria para habilitar el boton "Siguiente".
        </p>

        <q-badge
          class="pd-badge q-mb-sm"
          :class="templateMapperStore.isConfigValid ? 'pd-badge--active' : 'pd-badge--inactive'"
        >
          isConfigValid: {{ templateMapperStore.isConfigValid }}
        </q-badge>

        <pre class="pd-mono sandbox-state">{{ inspectedState }}</pre>
      </aside>
    </div>
  </q-page>
</template>

<style scoped lang="scss">
.sandbox-header {
  margin-bottom: 16px;
}

.pd-subtitle {
  margin: 4px 0 0;
}

.sandbox-grid {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  gap: 16px;
  align-items: start;
}

@media (max-width: 1023px) {
  .sandbox-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.sandbox-state {
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-border);
  border-radius: 8px;
  padding: 12px;
  margin: 0;
  overflow-x: auto;
  color: var(--pd-text-primary);
}
</style>
