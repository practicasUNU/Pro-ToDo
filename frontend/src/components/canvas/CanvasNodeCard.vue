<script setup lang="ts">
import { computed } from 'vue';
import { useQuasar } from 'quasar';

import { useCanvasStore } from '@stores/canvas.store';
import { useExecutionStore } from '@stores/execution.store';
import { extractApiErrorMessage } from '@/utils/api-error';
import { hasPurgedAttachments } from '@/utils/purged-attachments';
import { NODE_TYPE_LABELS, NodeType } from '@/types/pipeline';

import type { CanvasForkSlot, CanvasNodeStatus } from '@stores/canvas.store';
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
  [NodeType.PAUSA_FLOW]: 'pause_circle',
  [NodeType.DESTINO_HTTP_GENERICO]: 'http',
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
  RUNNING: { icon: 'autorenew', color: 'primary', label: 'Procesando' },
  COMPLETED: { icon: 'check_circle', color: 'positive', label: 'Completado' },
  PAUSED: { icon: 'pause_circle', color: 'warning', label: 'Pausado' },
  FAILED: { icon: 'error', color: 'negative', label: 'Fallido' },
};

interface Props {
  step: AssembledPipelineNode;
  /** Carril en el que se dibuja; decide el modificador y el texto accesible. */
  variant?: 'nominal' | 'contingency' | 'orphan';
  /** Posicion en el camino nominal, 0-based. Solo en `nominal`. */
  index?: number;
  /** Ruta que trajo hasta aqui. Solo en `contingency`. */
  fork?: CanvasForkSlot | null;
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'nominal',
  index: 0,
  fork: null,
});

const canvasStore = useCanvasStore();
const executionStore = useExecutionStore();
const $q = useQuasar();

const status = computed<CanvasNodeStatus>(() => canvasStore.statusOf(props.step.nodeId));

/**
 * Si esta tarjeta ofrece relanzar la ejecucion desde su nodo.
 *
 * La condicion la decide el store, que replica la del backend. NO se exige
 * ademas la query `?resume=true`: esa solo es el atajo con el que se llega
 * desde la tabla, y condicionar el boton a ella esconderia la accion a quien
 * abriese el canvas por su cuenta teniendo una ejecucion detenida delante.
 */
const canResumeHere = computed<boolean>(() => canvasStore.isResumableFrom(props.step.nodeId));

const badge = computed(() => STATUS_BADGES[status.value]);

const label = computed<string>(() => NODE_TYPE_LABELS[props.step.nodeType]);

const cardClasses = computed<string[]>(() => {
  const classes = ['pd-card', 'pd-node-card', `pd-node-card--${status.value.toLowerCase()}`];

  if (props.variant === 'contingency') {
    classes.push('pd-node-card--contingency');
  }

  if (props.variant === 'orphan') {
    classes.push('pd-node-card--orphan');
  }

  if (canvasStore.selectedNodeId === props.step.nodeId) {
    classes.push('pd-node-card--selected');
  }

  return classes;
});

/** Nombre legible de un nodo del esquema, para los textos accesibles. */
const nameOf = (nodeId: string): string => {
  const node = canvasStore.workflow?.pipelineSchema?.nodes[nodeId];

  return node === undefined ? nodeId : NODE_TYPE_LABELS[node.nodeType];
};

/**
 * Texto accesible completo de la tarjeta.
 *
 * Sustituye al titulo "Rutas de contingencia" que el carril ya no tiene: dice
 * de que nodo cuelga, bajo que condicion, y si devuelve el flujo al camino
 * nominal. Toda la informacion que el trazo transmite visualmente viaja aqui
 * como texto, porque el SVG es decorativo.
 */
const ariaLabel = computed<string>(() => {
  if (props.variant === 'orphan') {
    return `Nodo sin ruta declarada: ${label.value} — ${badge.value.label}`;
  }

  if (props.variant === 'contingency' && props.fork !== null) {
    const condition =
      props.fork.catchErrors === null
        ? 'ante cualquier fallo'
        : `si ${props.fork.catchErrors.join(' o ')}`;
    const rejoin =
      props.fork.rejoin === null ? '' : `. Vuelve al paso ${props.fork.rejoin.column + 1}`;

    return `Contingencia de ${nameOf(props.fork.fromNodeId)} ${condition}: ${label.value} — ${badge.value.label}${rejoin}`;
  }

  return `Paso ${props.index + 1}: ${label.value} — ${badge.value.label}`;
});

/**
 * Tipos de nodo que consumen los binarios del correo.
 *
 * Son los unicos a los que les afecta la purga de RNF-01: el resto del grafo
 * trabaja sobre texto ya extraido y reanudar desde ellos no reutiliza nada.
 */
const BINARY_CONSUMER_TYPES: readonly NodeType[] = [
  NodeType.PROCESADOR_OCR,
  NodeType.PARSER_PRE_IA,
];

/**
 * Reanudar desde aqui reutilizara una extraccion ya hecha, no el fichero.
 *
 * Dos condiciones, y las dos hacen falta. Que el nodo sea de los que leen los
 * adjuntos —si no, la purga le da igual— y que los binarios ya no esten en el
 * contexto. Se mira el TIPO y no el `nodeId`: `ocr_ia` es solo el nombre que
 * suele ponerles el asistente, y atar el aviso a esa cadena lo apagaria en
 * cuanto alguien renombrara el paso.
 */
const reusesCachedExtraction = computed<boolean>(
  () =>
    BINARY_CONSUMER_TYPES.includes(props.step.nodeType) &&
    hasPurgedAttachments(canvasStore.executionContext),
);

/**
 * Relanza la ejecucion detenida desde este nodo, previa confirmacion.
 *
 * El dialogo NO lleva el temporizador de 5 segundos: ese esta reservado a lo
 * irreversible —descartar una ejecucion, dar de baja un flujo—, y reanudar no
 * destruye nada. Lo que si hace falta es confirmar, porque reanudar desde un
 * paso anterior REPITE trabajo ya hecho, y en un flujo que publica eso puede
 * significar un segundo envio.
 *
 * Cuando el paso consume adjuntos YA LIBERADOS, el mensaje cambia: el operador
 * suele reanudar ahi justamente porque cambio el fichero o el prompt, y esa es
 * la unica expectativa que el sistema no puede cumplir —el binario se tiro a
 * proposito al terminar el nodo (RNF-01) y lo que se reutiliza es la
 * transcripcion que quedo en el contexto. Decirlo ANTES es lo que evita que
 * alguien concluya que su cambio no surtio efecto.
 */
const requestResume = (): void => {
  const executionId = canvasStore.observedExecution?.executionId;

  if (executionId === undefined) return;

  const baseMessage = `La ejecucion continuara desde "${label.value}". Los pasos que vengan despues volveran a ejecutarse.`;
  const purgedWarning =
    'Atencion: los archivos binarios originales se liberaron de memoria tras el procesamiento previo (RNF-01). Reanudar desde este nodo reutilizara la extraccion de texto ya realizada. Si el archivo o los prompts cambiaron, esos cambios NO se aplicaran a este paso.';

  $q.dialog({
    title: 'Reanudar desde este paso',
    message: reusesCachedExtraction.value ? `${baseMessage} ${purgedWarning}` : baseMessage,
    cancel: { flat: true, label: 'Cancelar', class: 'pd-btn-secondary' },
    ok: { unelevated: true, label: 'Reanudar', color: 'primary' },
    persistent: true,
  }).onOk(() => {
    void resumeFromHere(executionId);
  });
};

/** Despacha la reanudacion y recarga el canvas con el desenlace. */
const resumeFromHere = async (executionId: string): Promise<void> => {
  try {
    await executionStore.resumeExecution(executionId, props.step.nodeId);
    $q.notify({ type: 'positive', icon: 'play_arrow', message: 'Ejecucion reanudada' });
    const flowId = canvasStore.workflow?.id;

    if (flowId !== undefined) {
      await canvasStore.loadCanvas(flowId);
    }
  } catch (error: unknown) {
    $q.notify({
      type: 'negative',
      icon: 'error',
      message: extractApiErrorMessage(error, 'No se pudo reanudar la ejecucion'),
    });
  }
};

/** Otros nodos que desvian al mismo destino, ya en texto legible. */
const sourcesText = computed<string | null>(() => {
  const sources = props.fork?.sourceNodeIds ?? [];

  return sources.length > 1 ? sources.map(nameOf).join(', ') : null;
});
</script>

<template>
  <!-- Tarjeta de SOLO LECTURA: un clic solo abre la inspeccion, nunca muta el
       grafo (`frontend-quasar.md` §4). -->
  <div
    role="listitem"
    tabindex="0"
    :class="cardClasses"
    :aria-label="ariaLabel"
    @click="canvasStore.selectNode(step.nodeId)"
    @keydown.enter="canvasStore.selectNode(step.nodeId)"
    @keydown.space.prevent="canvasStore.selectNode(step.nodeId)"
  >
    <div class="row items-center no-wrap q-gutter-sm">
      <q-icon :name="NODE_ICONS[step.nodeType]" size="22px" color="primary" />
      <div class="col">
        <div class="pd-label">{{ label }}</div>
        <div class="pd-mono pd-node-type">{{ step.nodeId }}</div>
      </div>
    </div>

    <div class="row items-center q-mt-sm q-gutter-xs">
      <q-badge :color="badge.color" class="pd-badge">
        <q-icon :name="badge.icon" size="13px" class="q-mr-xs" />
        {{ badge.label }}
      </q-badge>
      <!-- El spinner acompana al badge en vez de sustituirlo: el badge dice QUE
           pasa y el spinner que sigue pasando ahora mismo. -->
      <q-spinner-dots v-if="status === 'RUNNING'" :color="badge.color" size="18px" />

      <q-space />

      <!-- Reanudacion selectiva (CU-09 extendido). Solo en los nodos elegibles:
           ofrecerlo en los demas produciria un 400 que el operador leeria como
           un fallo del sistema. `.stop` porque la tarjeta entera abre la
           inspeccion al pulsarla, y reanudar no es inspeccionar.

           Actua sobre la EJECUCION, no sobre el grafo: el canvas sigue siendo
           de solo lectura en lo que a topologia se refiere
           (`frontend-quasar.md` §4). -->
      <q-btn
        v-if="canResumeHere"
        flat
        round
        dense
        icon="play_arrow"
        color="warning"
        :loading="executionStore.isResuming"
        data-test="resume-from-node"
        :aria-label="`Reanudar la ejecucion desde ${label}`"
        @click.stop="requestResume"
        @keydown.enter.stop
        @keydown.space.stop
      >
        <q-tooltip>Reanudar desde este paso</q-tooltip>
      </q-btn>
    </div>

    <div v-if="variant === 'nominal'" class="pd-mono pd-node-type q-mt-xs">
      {{ step.outputNamespace }}
    </div>

    <!-- Quien mas desvia hasta aqui. Solo aparece cuando son varios, porque la
         tarjeta es UNICA por nodo y hay que poder saber de donde se llega. -->
    <div v-if="sourcesText !== null" class="pd-fork-sources q-mt-xs">
      <q-icon name="call_merge" size="14px" aria-hidden="true" />
      <span class="pd-mono">Recibe de: {{ sourcesText }}</span>
    </div>

    <!-- El satelite devuelve el flujo al camino nominal. Se dice con el numero
         de paso y no con una flecha de vuelta: en un carril con scroll, los dos
         extremos de esa arista caen fuera de pantalla a la vez. -->
    <div v-if="fork?.rejoin" class="pd-fork-rejoin q-mt-xs">
      <q-icon name="u_turn_right" size="14px" aria-hidden="true" />
      <span class="pd-mono">
        Vuelve al paso {{ fork.rejoin.column + 1 }} · {{ nameOf(fork.rejoin.nodeId) }}
      </span>
    </div>
  </div>
</template>
