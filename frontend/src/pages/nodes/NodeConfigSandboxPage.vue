<script setup lang="ts">
import { computed, onMounted, provide, ref, shallowRef, watch } from 'vue';

import { useNodeCatalogStore } from '@stores/node-catalog.store';
import { resolveNodeStore } from '@stores/nodes/node-store-registry';

import { configurableNodeTypes, nodeConfigRegistry } from '@components/nodes/node-config-registry';
import NodeSandboxRunner from '@components/nodes/NodeSandboxRunner.vue';
import { NODE_SANDBOX_MODE_KEY } from '@components/nodes/node-sandbox-mode';

import { buildContextForNamespaces } from '@/utils/upstream-catalog';

import { TEMPLATE_NAMESPACES } from '@/types/html-template';
import { useSelectFilter } from '@/composables/useSelectFilter';

import { NODE_TYPE_LABELS, NodeType } from '@/types/pipeline';

import type { NodeConfigStore, UpstreamNamespace } from '@stores/nodes/node-store-registry';

// Banco de pruebas de la resolucion polimorfica (regla frontend-quasar.md §3.1).
//
// Existe porque el asistente de creacion de flujos (Vista 3+4, PROT-12) aun no
// esta implementado, y sin un anfitrion los configuradores de nodo no se pueden
// ver funcionando. Reproduce lo unico que el asistente hara con ellos: resolver
// el componente por `nodeType` y leer `isConfigValid` para decidir si avanza.

/**
 * `nodeId` del nodo simulado.
 *
 * Constante compartida por el configurador montado y por el store que este banco
 * inspecciona: los stores de nodo se instancian POR `nodeId`, asi que montar el
 * formulario con uno y leer el store de otro dejaria el panel de estado mirando
 * una instancia vacia distinta de la que se esta editando.
 *
 * Un UNICO id para todos los tipos es correcto y no colisiona: cada store usa su
 * propio prefijo de Pinia (`node-parser-email:nodo_demo`,
 * `templateMapperNode:nodo_demo`), de modo que son instancias distintas. Ademas
 * es lo que permite alternar entre tipos sin perder lo escrito en cada uno.
 */
const SANDBOX_NODE_ID = 'nodo_demo';

// Los configuradores montados aqui saben que estan en el banco: el destino
// Drupal se encierra en el entorno de pruebas (toggle fijo en Sandbox).
provide(NODE_SANDBOX_MODE_KEY, true);

const selectedNodeType = ref<NodeType>(NodeType.MAPEADOR_PLANTILLA);

const nodeTypeOptions = computed(() =>
  configurableNodeTypes.map((nodeType) => ({
    label: NODE_TYPE_LABELS[nodeType],
    value: nodeType,
  })),
);

// Filtrado predictivo: el banco de pruebas lista los diez tipos configurables.
const { filteredOptions: filteredNodeTypeOptions, filterFn: filterNodeTypes } =
  useSelectFilter(nodeTypeOptions);

// Sin `v-if` por tipo: el componente sale del registro (regla §3.1).
const resolvedComponent = computed(() => nodeConfigRegistry[selectedNodeType.value] ?? null);

/**
 * Namespaces que se simula que aportan los nodos previos.
 *
 * La fuente de verdad es este `ref` local y no el store: `availableUpstreamNamespaces`
 * no forma parte de `NodeConfigStore`, y leerlo desde el anfitrion era justo la
 * inspeccion de la configuracion ajena que §3.1 prohibe.
 *
 * Se declara ANTES que el store activo porque `syncActiveStore` lo lee y el
 * `watch` que lo invoca es `immediate`: en `<script setup>` el orden de
 * declaracion es el de ejecucion.
 */
const simulatedUpstream = ref<string[]>([...TEMPLATE_NAMESPACES]);

/**
 * Store del tipo activo, resuelto por REGISTRO igual que el componente.
 *
 * Antes se importaba `useTemplateMapperStore` directamente, y el panel de estado
 * se quedaba mirando al mapeador aunque el selector montara otro configurador.
 *
 * `shallowRef` y no `ref`: el valor es el proxy de un store que YA es reactivo, y
 * envolverlo en reactividad profunda solo anadiria una travesia inutil de todo su
 * estado en cada reasignacion.
 */
const activeStore = shallowRef<NodeConfigStore | null>(null);

const nodeCatalogStore = useNodeCatalogStore();

/**
 * Contexto rico equivalente a los namespaces marcados en el banco.
 *
 * Sin esto, un nodo que solo implemente el canal rico —el extractor web— saldria
 * del banco con el selector permanentemente deshabilitado: recibiria los nombres
 * por un canal que no escucha y nada por el que si.
 *
 * La resolucion nombre -> campos vive en `@/utils/upstream-catalog`, compartida
 * con el explorador de variables del editor de plantillas: es la misma pregunta
 * —"que publicaria este namespace"— y dos copias de la inversion del mapa de
 * defectos acabarian discrepando.
 */
const buildSimulatedContext = (namespaces: string[]): UpstreamNamespace[] =>
  buildContextForNamespaces(namespaces, nodeCatalogStore.findByCode);

/**
 * Reapunta el store activo y le traslada el contexto simulado.
 *
 * Deliberadamente IMPERATIVO y no un `computed`: `resolveNodeStore` invoca un
 * hook de Pinia, que registra la instancia en `pinia.state.value`. Un getter con
 * un efecto colateral dentro es un contrato roto aunque no siempre estalle.
 *
 * Sin `try/catch` a proposito: `resolveNodeStore` devuelve `null` cuando el tipo
 * no esta registrado y no lanza, asi que un `catch` seria una rama inalcanzable
 * fingiendo manejar un fallo que el contrato no produce.
 *
 * `?.()` porque el metodo es OPCIONAL en el contrato: un disparador es el primero
 * del grafo y no tiene nada aguas arriba que declarar.
 */
const syncActiveStore = (nodeType: NodeType): void => {
  const store = resolveNodeStore(nodeType, SANDBOX_NODE_ID);

  activeStore.value = store;
  store?.setAvailableUpstreamNamespaces?.([...simulatedUpstream.value]);
  store?.setAvailableUpstreamContext?.(buildSimulatedContext(simulatedUpstream.value));
};

// Solo el cambio de TIPO reapunta el store. Antes esto era un
// `watch([activeStore, simulatedUpstream], ..., { deep: true })`, y el `deep`
// sobre el propio store suscribia el vigilante a todo el estado que su callback
// escribia: como el setter del mapeador asigna un array NUEVO en cada llamada, el
// ciclo no tenia punto fijo y reventaba al montar con
// `Maximum recursive updates exceeded`.
watch(selectedNodeType, syncActiveStore, { immediate: true });

/**
 * Carga el catalogo y REPITE la sincronizacion cuando llega.
 *
 * El `watch` de arriba es `immediate`, asi que la primera sincronizacion ocurre
 * con el catalogo todavia vacio y el contexto sale sin campos. Resincronizar al
 * resolverse es lo que hace que el selector del extractor web aparezca poblado
 * sin que el operador tenga que cambiar de tipo de nodo y volver.
 *
 * `fetchCatalog` se memoiza, de modo que entrar y salir del banco no repite la
 * peticion.
 */
onMounted(async () => {
  await nodeCatalogStore.fetchCatalog();
  syncActiveStore(selectedNodeType.value);
});

/**
 * El nodo activo declara depender del contexto que dejan los nodos previos.
 *
 * Basta con que implemente UNO de los dos canales: el mapeador solo escucha el
 * de nombres y el extractor web solo el de campos, y ambos dependen del
 * contexto igual.
 */
const acceptsUpstream = computed<boolean>(
  () =>
    activeStore.value?.setAvailableUpstreamNamespaces !== undefined ||
    activeStore.value?.setAvailableUpstreamContext !== undefined,
);

/**
 * Unico punto de escritura de la simulacion aguas arriba.
 *
 * Reemplaza al vigilante circular: aqui la escritura la origina un evento de la
 * interfaz y no una dependencia reactiva del propio dato escrito, de modo que la
 * realimentacion es imposible por construccion.
 */
const onUpstreamToggle = (namespaces: string[]): void => {
  simulatedUpstream.value = namespaces;
  activeStore.value?.setAvailableUpstreamNamespaces?.([...namespaces]);
  activeStore.value?.setAvailableUpstreamContext?.(buildSimulatedContext(namespaces));
};

/**
 * Lo que el asistente inspeccionaria del nodo activo.
 *
 * SOLO lo que el contrato `NodeConfigStore` expone. Antes se leian
 * `requiredVariables`, `missingRequiredVariables` y `availableUpstreamNamespaces`,
 * que son campos privados del mapeador: ataban el banco a un tipo concreto, que
 * es lo contrario de lo que este banco existe para demostrar.
 *
 * `toNodeParams()` dentro de un `computed` se reevalua con cada cambio de la
 * configuracion. Es correcto porque el metodo es puro y sin E/S: publica lo que
 * el nodo aportaria al `pipeline_schema`, sin tocar nada.
 */
/** Contexto simulado actual, para que el ejecutor genere sus datos de ejemplo. */
const simulatedContext = computed<UpstreamNamespace[]>(() =>
  buildSimulatedContext(simulatedUpstream.value),
);

const inspectedState = computed(() =>
  JSON.stringify(
    {
      nodeType: selectedNodeType.value,
      isConfigValid: activeStore.value?.isConfigValid ?? null,
      params: activeStore.value?.toNodeParams() ?? null,
      configWarnings: activeStore.value?.configWarnings ?? [],
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
            :options="filteredNodeTypeOptions"
            outlined
            dense
            emit-value
            map-options
            use-input
            fill-input
            hide-selected
            input-debounce="0"
            class="q-mt-xs"
            @filter="filterNodeTypes"
          />
        </div>

        <component :is="resolvedComponent" v-if="resolvedComponent" :node-id="SANDBOX_NODE_ID" />

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
          :class="activeStore?.isConfigValid ? 'pd-badge--active' : 'pd-badge--inactive'"
        >
          isConfigValid: {{ activeStore?.isConfigValid ?? 'sin store registrado' }}
        </q-badge>

        <pre class="pd-mono sandbox-state">{{ inspectedState }}</pre>

        <!-- Ejecucion REAL aislada: solo para los tipos y roles que el backend
             admite (IA y OCR, ADMIN; HTTP generico, tambien EDITOR). -->
        <template v-if="activeStore !== null">
          <q-separator class="q-my-md sandbox-separator" />
          <NodeSandboxRunner
            :node-type="selectedNodeType"
            :params="activeStore.toNodeParams()"
            :is-config-valid="activeStore.isConfigValid"
            :upstream="simulatedContext"
          />
        </template>

        <q-separator class="q-my-md sandbox-separator" />

        <div class="pd-h2 q-mb-sm">Simulacion de Namespaces Previos</div>
        <p class="pd-subtitle q-mb-sm">
          Lo que dejarian en el contexto los nodos anteriores del flujo. Desmarca uno que la
          plantilla exija y <span class="pd-mono">isConfigValid</span> pasa a
          <span class="pd-mono">false</span>.
        </p>

        <p v-if="!acceptsUpstream" class="pd-subtitle q-mb-sm">
          Este tipo de nodo no declara dependencias aguas arriba, asi que la simulacion no le
          afecta.
        </p>

        <div class="sandbox-namespaces">
          <q-checkbox
            v-for="namespace in TEMPLATE_NAMESPACES"
            :key="namespace"
            :model-value="simulatedUpstream"
            :val="namespace"
            dense
            :disable="!acceptsUpstream"
            class="pd-mono sandbox-namespace"
            :label="namespace"
            @update:model-value="onUpstreamToggle"
          />
        </div>
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

.sandbox-separator {
  background: var(--pd-border);
}

.sandbox-namespaces {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sandbox-namespace {
  color: var(--pd-text-primary);
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
