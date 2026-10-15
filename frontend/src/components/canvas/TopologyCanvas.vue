<script setup lang="ts">
import { computed } from 'vue';

import { useCanvasStore } from '@stores/canvas.store';
import { NODE_TYPE_LABELS, NodeType } from '@/types/pipeline';

import type { CanvasNodeStatus } from '@stores/canvas.store';
import type { AssembledPipelineNode } from '@/types/pipeline';

/**
 * Icono por tipo de nodo.
 *
 * Vive en el componente y no en `@/types`: es presentacion pura, y el backend
 * no tiene ni debe tener opinion sobre con que glifo se dibuja un nodo.
 */
const NODE_ICONS: Record<NodeType, string> = {
  [NodeType.TRIGGER_IMAP]: 'mail',
  [NodeType.TRIGGER_CRON]: 'schedule',
  [NodeType.PARSER_PRE_IA]: 'segment',
  [NodeType.EXTRACTOR_WEB]: 'public',
  [NodeType.PROCESADOR_IA]: 'psychology',
  [NodeType.ESCUDO_POST_IA]: 'gavel',
  [NodeType.MAPEADOR_PLANTILLA]: 'dashboard_customize',
  [NodeType.DESTINO_DRUPAL]: 'language',
  [NodeType.DESTINO_SMTP]: 'forward_to_inbox',
  [NodeType.PROCESADOR_OCR]: 'document_scanner',
};

/**
 * Distintivo de cada estado: icono, color y texto.
 *
 * El color NUNCA viaja solo. Un operador que no distingue verde de ambar tiene
 * que poder leer el estado igual, y por eso cada entrada lleva tambien glifo y
 * etiqueta.
 */
const STATUS_BADGES: Record<
  CanvasNodeStatus,
  { readonly icon: string; readonly color: string; readonly label: string }
> = {
  IDLE: { icon: 'radio_button_unchecked', color: 'grey-6', label: 'En espera' },
  RUNNING: { icon: 'autorenew', color: 'info', label: 'Ejecutando' },
  COMPLETED: { icon: 'check_circle', color: 'positive', label: 'Completado' },
  PAUSED: { icon: 'pause_circle', color: 'warning', label: 'Pausado' },
  FAILED: { icon: 'error', color: 'negative', label: 'Fallido' },
};

const canvasStore = useCanvasStore();

const steps = computed<AssembledPipelineNode[]>(() => canvasStore.orderedSteps);

const contingencySteps = computed<AssembledPipelineNode[]>(() => canvasStore.contingencySteps);

/**
 * El tramo entre dos cajas ya se recorrio.
 *
 * Se mira el ORIGEN y no el destino: la flecha describe una transicion que ya
 * ocurrio en cuanto el nodo de la izquierda termino, aunque el de la derecha
 * aun no haya arrancado.
 */
const isTraversed = (step: AssembledPipelineNode): boolean =>
  canvasStore.statusOf(step.nodeId) === 'COMPLETED';

const cardClasses = (step: AssembledPipelineNode, isContingency = false): string[] => {
  const classes = [
    'pd-card',
    'pd-node-card',
    `pd-node-card--${canvasStore.statusOf(step.nodeId).toLowerCase()}`,
  ];

  if (isContingency) {
    classes.push('pd-node-card--contingency');
  }

  if (canvasStore.selectedNodeId === step.nodeId) {
    classes.push('pd-node-card--selected');
  }

  return classes;
};

const badgeOf = (step: AssembledPipelineNode): (typeof STATUS_BADGES)[CanvasNodeStatus] =>
  STATUS_BADGES[canvasStore.statusOf(step.nodeId)];
</script>

<template>
  <!-- Lienzo de SOLO LECTURA: ni arrastre ni eventos de mutacion
       (`frontend-quasar.md` §4). Un clic solo abre la inspeccion. -->
  <div class="pd-canvas" role="list" aria-label="Topologia del flujo">
    <template v-for="(step, index) in steps" :key="step.nodeId">
      <div
        role="listitem"
        tabindex="0"
        :class="cardClasses(step)"
        :aria-label="`Paso ${index + 1}: ${NODE_TYPE_LABELS[step.nodeType]} — ${badgeOf(step).label}`"
        @click="canvasStore.selectNode(step.nodeId)"
        @keydown.enter="canvasStore.selectNode(step.nodeId)"
        @keydown.space.prevent="canvasStore.selectNode(step.nodeId)"
      >
        <div class="row items-center no-wrap q-gutter-sm">
          <q-icon :name="NODE_ICONS[step.nodeType]" size="22px" color="primary" />
          <div class="col">
            <div class="pd-label">{{ NODE_TYPE_LABELS[step.nodeType] }}</div>
            <div class="pd-mono pd-node-type">{{ step.nodeId }}</div>
          </div>
        </div>

        <div class="row items-center q-mt-sm q-gutter-xs">
          <q-badge :color="badgeOf(step).color" class="pd-badge">
            <q-icon :name="badgeOf(step).icon" size="13px" class="q-mr-xs" />
            {{ badgeOf(step).label }}
          </q-badge>
          <!-- El spinner acompana al badge en vez de sustituirlo: el badge dice
               QUE pasa y el spinner que sigue pasando ahora mismo. -->
          <q-spinner-dots
            v-if="canvasStore.statusOf(step.nodeId) === 'RUNNING'"
            color="info"
            size="18px"
          />
        </div>

        <div class="pd-mono pd-node-type q-mt-xs">{{ step.outputNamespace }}</div>
      </div>

      <q-icon
        v-if="index < steps.length - 1"
        name="arrow_forward"
        size="24px"
        class="pd-canvas-link"
        :class="{ 'pd-canvas-link--traversed': isTraversed(step) }"
        aria-hidden="true"
      />
    </template>

    <q-banner v-if="steps.length === 0" class="pd-card">
      Este flujo todavia no tiene un esquema de pipeline guardado.
    </q-banner>
  </div>

  <!-- Derivaciones de contingencia: destinos de un `onErrorStep` que nadie
       encadena con `nextStep`, de modo que no estan en el camino nominal. -->
  <div v-if="contingencySteps.length > 0" class="q-px-md q-pb-md">
    <div class="pd-subtitle q-mb-sm">Rutas de contingencia</div>
    <div class="pd-canvas">
      <div
        v-for="step in contingencySteps"
        :key="step.nodeId"
        role="listitem"
        tabindex="0"
        :class="cardClasses(step, true)"
        :aria-label="`Contingencia: ${NODE_TYPE_LABELS[step.nodeType]} — ${badgeOf(step).label}`"
        @click="canvasStore.selectNode(step.nodeId)"
        @keydown.enter="canvasStore.selectNode(step.nodeId)"
        @keydown.space.prevent="canvasStore.selectNode(step.nodeId)"
      >
        <div class="row items-center no-wrap q-gutter-sm">
          <q-icon :name="NODE_ICONS[step.nodeType]" size="22px" color="primary" />
          <div class="col">
            <div class="pd-label">{{ NODE_TYPE_LABELS[step.nodeType] }}</div>
            <div class="pd-mono pd-node-type">{{ step.nodeId }}</div>
          </div>
        </div>

        <div class="row items-center q-mt-sm q-gutter-xs">
          <q-badge :color="badgeOf(step).color" class="pd-badge">
            <q-icon :name="badgeOf(step).icon" size="13px" class="q-mr-xs" />
            {{ badgeOf(step).label }}
          </q-badge>
          <q-spinner-dots
            v-if="canvasStore.statusOf(step.nodeId) === 'RUNNING'"
            color="info"
            size="18px"
          />
        </div>
      </div>
    </div>
  </div>
</template>
