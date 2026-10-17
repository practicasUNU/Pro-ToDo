<script setup lang="ts">
import { computed } from 'vue';

import CanvasNodeCard from '@components/canvas/CanvasNodeCard.vue';
import { useCanvasStore } from '@stores/canvas.store';
import { NODE_TYPE_LABELS } from '@/types/pipeline';

import type { CanvasEdge, CanvasForkSlot } from '@stores/canvas.store';
import type { AssembledPipelineNode } from '@/types/pipeline';

/** Codigos que se listan antes de resumir el resto con un `+N`. */
const MAX_VISIBLE_CODES = 2;

/** Icono de cada tipo de referencia a una tarjeta que ya existe. */
const REF_ICONS: Record<string, string> = {
  rejoin: 'u_turn_right',
  duplicate: 'subdirectory_arrow_right',
  missing: 'error_outline',
};

const canvasStore = useCanvasStore();

const steps = computed<AssembledPipelineNode[]>(() => canvasStore.orderedSteps);

const nominalEdges = computed<CanvasEdge[]>(() => canvasStore.nominalEdges);

const forkSlots = computed<CanvasForkSlot[]>(() => canvasStore.forkSlots);

/** Nombre legible de un nodo del esquema; cae al `nodeId` si ya no existe. */
const nameOf = (nodeId: string): string => {
  const node = canvasStore.workflow?.pipelineSchema?.nodes[nodeId];

  return node === undefined ? nodeId : NODE_TYPE_LABELS[node.nodeType];
};

/**
 * Alcance de la ruta, en una linea.
 *
 * El arreglo VACIO no es un detalle menor: el backend guarda sin protestar una
 * ruta selectiva sin codigos, y esa ruta no se dispara jamas. Este es el unico
 * sitio donde el operador puede enterarse.
 */
const codesText = (fork: CanvasForkSlot): string => {
  if (fork.catchErrors === null) {
    // GRAVE y no "cualquiera" a secas: esta es la forma de cadena del motor,
    // que es la unica que atrapa todo, y lo que atrapa es lo que desvia el
    // flujo. Un LEVE lo cierra el motor solo —no pausa, no reserva cursor y el
    // sondeo vuelve en un minuto— y un URGENTE es irrecuperable, de modo que
    // la rama de contingencia existe, en la practica, para los GRAVE.
    return 'Cualquier fallo grave';
  }

  if (fork.catchErrors.length === 0) {
    return 'Sin codigos: no se dispara';
  }

  const visible = fork.catchErrors.slice(0, MAX_VISIBLE_CODES).join(' · ');
  const hidden = fork.catchErrors.length - MAX_VISIBLE_CODES;

  return hidden > 0 ? `Solo ${visible} +${hidden}` : `Solo ${visible}`;
};

/** Lista completa de codigos, para el `title` cuando no caben todos. */
const codesTitle = (fork: CanvasForkSlot): string | undefined =>
  fork.catchErrors !== null && fork.catchErrors.length > MAX_VISIBLE_CODES
    ? fork.catchErrors.join(', ')
    : undefined;

/** Texto del chip que sustituye a una tarjeta ya dibujada en otro sitio. */
const refText = (fork: CanvasForkSlot): string => {
  if (fork.placement === 'missing') {
    return `Destino inexistente: ${fork.toNodeId}`;
  }

  if (fork.placement === 'rejoin') {
    const column = steps.value.findIndex((step) => step.nodeId === fork.toNodeId);

    return `vuelve al paso ${column + 1} · ${nameOf(fork.toNodeId)}`;
  }

  return `${nameOf(fork.toNodeId)}, ya mostrado`;
};

const refAriaLabel = (fork: CanvasForkSlot): string =>
  `En caso de error grave en ${nameOf(fork.fromNodeId)}, continua en ${refText(fork)}`;
</script>

<template>
  <!-- Contenedor de scroll. El `role="list"` NO vive aqui sino en cada carril:
       una lista cuyos hijos no son todos `listitem` es una violacion ARIA, y
       con dos filas de tarjetas eso es inevitable. -->
  <div class="pd-canvas">
    <div
      class="pd-canvas-rail pd-canvas-rail--nominal"
      role="list"
      aria-label="Camino nominal del flujo"
    >
      <template v-for="(step, index) in steps" :key="step.nodeId">
        <CanvasNodeCard :step="step" variant="nominal" :index="index" />

        <q-icon
          v-if="nominalEdges[index]"
          name="arrow_forward"
          size="24px"
          class="pd-canvas-link"
          :class="{ 'pd-canvas-link--traversed': nominalEdges[index]?.isTraversed }"
          aria-hidden="true"
        />
      </template>
    </div>

    <!-- Carril de contingencias: ESPEJO del nominal. Cada celda mide lo mismo
         que la tarjeta de arriba aunque este vacia, y es eso lo que hace caer
         el trazo bajo el nodo que lo declara sin medir nada en JavaScript. -->
    <div
      v-if="forkSlots.length > 0"
      class="pd-canvas-rail pd-canvas-rail--forks"
      role="list"
      aria-label="Bifurcaciones de contingencia"
    >
      <template v-for="(step, index) in steps" :key="`fork-${step.nodeId}`">
        <div class="pd-canvas-slot" role="presentation">
          <template
            v-for="fork in canvasStore.forkByColumn.get(index) ?? []"
            :key="`${fork.fromNodeId}-${fork.toNodeId}`"
          >
            <div class="pd-fork">
              <!-- Decorativo: todo lo que dice viaja como texto en la etiqueta
                   de al lado y en el `aria-label` de la tarjeta destino. El
                   color sale de `currentColor`, que la clase fija en un token. -->
              <svg
                class="pd-canvas-fork"
                :class="{ 'pd-canvas-fork--traversed': fork.isTraversed }"
                width="24"
                height="56"
                viewBox="0 0 24 56"
                aria-hidden="true"
                focusable="false"
              >
                <line
                  x1="12"
                  y1="0"
                  x2="12"
                  y2="42"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-dasharray="5 4"
                  stroke-linecap="round"
                />
                <path d="M12 54 L6 42 L18 42 Z" fill="currentColor" />
              </svg>

              <div class="pd-fork-label">
                <div class="pd-label">EN CASO DE ERROR GRAVE</div>
                <div
                  class="pd-mono pd-fork-label__codes"
                  :class="{ 'pd-fork-label__codes--inert': fork.catchErrors?.length === 0 }"
                  :title="codesTitle(fork)"
                >
                  {{ codesText(fork) }}
                </div>
              </div>
            </div>

            <CanvasNodeCard
              v-if="fork.placement === 'card' && fork.target !== null"
              :step="fork.target"
              variant="contingency"
              :fork="fork"
            />
            <!-- UNA tarjeta por nodo en todo el lienzo: el alertador es uno por
                 flujo, y duplicarlo haria leer dos donde hay uno. -->
            <button
              v-else
              type="button"
              class="pd-fork-ref"
              :class="{ 'pd-fork-ref--missing': fork.placement === 'missing' }"
              :aria-label="refAriaLabel(fork)"
              @click="fork.target !== null && canvasStore.selectNode(fork.toNodeId)"
            >
              <q-icon :name="REF_ICONS[fork.placement]" size="16px" aria-hidden="true" />
              <span>{{ refText(fork) }}</span>
            </button>
          </template>
        </div>

        <div v-if="index < steps.length - 1" class="pd-canvas-gap" aria-hidden="true" />
      </template>
    </div>

    <!-- Nodos a los que no apunta nada. Sin esto desaparecerian de la vista al
         retirarse el bloque inferior, y un nodo huerfano que nadie ve es un
         nodo que nadie arregla. -->
    <div
      v-if="canvasStore.unreachableSteps.length > 0"
      class="pd-canvas-rail pd-canvas-rail--orphans"
      role="list"
      aria-label="Nodos sin ruta declarada"
    >
      <CanvasNodeCard
        v-for="step in canvasStore.unreachableSteps"
        :key="step.nodeId"
        :step="step"
        variant="orphan"
      />
    </div>

    <q-banner v-if="steps.length === 0" class="pd-card">
      Este flujo todavia no tiene un esquema de pipeline guardado.
    </q-banner>
  </div>
</template>
