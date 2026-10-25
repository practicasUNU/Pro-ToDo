<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { copyToClipboard, useQuasar, type QTableColumn } from 'quasar';
import { useRouter } from 'vue-router';

import { useExecutionStore } from '@stores/execution.store';
import { useWorkflowTemplatesStore } from '@stores/workflow-templates.store';
import { useWorkflowsStore } from '@stores/workflows.store';

import AuditDetailsMenu from '@components/shared/AuditDetailsMenu.vue';
import SafeDeleteModal from '@components/shared/SafeDeleteModal.vue';
import StatusBadge from '@components/shared/StatusBadge.vue';

import WorkflowDialog from './WorkflowDialog.vue';

import { extractApiErrorMessage } from '@/utils/api-error';
import { describeExecutionState } from '@/utils/execution-state-display';
import { describeWorkflowStatus } from '@/utils/status-display';

import { ExecutionState } from '@/types/execution';
import { WorkflowStatus } from '@/types/pipeline';

import type { ExecutionSummary } from '@/types/execution';
import type { PipelineSummary } from '@/types/pipeline';

const $q = useQuasar();
const router = useRouter();
const workflowsStore = useWorkflowsStore();
// Solo para resolver el NOMBRE de la plantilla de origen: la tabla recibe un
// `templateId`, y un UUID no le dice nada al operador.
const templatesStore = useWorkflowTemplatesStore();
// Telemetria en vivo de cada fila. Los escuchadores del canal los engancha
// `useExecutionSocket` una sola vez en `MainLayout`, de modo que aqui solo se
// gestiona la pertenencia a las salas.
const executionStore = useExecutionStore();

const isEditorOpen = ref(false);
const isDeleteDialogOpen = ref(false);
const isDiscardDialogOpen = ref(false);

const editedWorkflow = ref<PipelineSummary | null>(null);
const workflowToDeactivate = ref<PipelineSummary | null>(null);
// Se guarda la EJECUCION y no el flujo: entre abrir el dialogo y confirmarlo
// pasan cinco segundos obligatorios, tiempo de sobra para que un `flow:resumed`
// ajeno cambie cual es la ejecucion vigente de ese flujo. Descartar la que se
// resolviera en ese momento cerraria una ejecucion distinta de la que el
// operador vio al pulsar.
const executionToDiscard = ref<string | null>(null);

// Admite `null` porque el boton `clearable` de QInput escribe eso, no una cadena
// vacia. QTable declara su prop `filter` como `any`, asi que el compilador no
// delataria la mentira: mas vale que el ref diga la verdad.
const filter = ref<string | null>('');

/** `id` de plantilla -> nombre, para la columna de procedencia. */
const templateNames = computed<Record<string, string>>(() =>
  Object.fromEntries(templatesStore.templates.map((template) => [template.id, template.name])),
);

const resolveTemplateName = (workflow: PipelineSummary): string =>
  workflow.templateId === null
    ? '—'
    : (templateNames.value[workflow.templateId] ?? 'Plantilla retirada');

const columns: QTableColumn<PipelineSummary>[] = [
  { name: 'name', label: 'Nombre', field: 'name', align: 'left', sortable: true },
  {
    name: 'description',
    label: 'Descripcion',
    field: (row: PipelineSummary) => row.description ?? '—',
    align: 'left',
    classes: 'pd-cell--long',
  },
  {
    name: 'template',
    label: 'Plantilla de origen',
    field: resolveTemplateName,
    align: 'left',
    sortable: true,
  },
  {
    name: 'nodes',
    label: 'Nodos',
    field: (row: PipelineSummary) => row.topology.length,
    align: 'center',
    sortable: true,
  },
  { name: 'status', label: 'Estado', field: 'status', align: 'center', sortable: true },
  { name: 'actions', label: 'Acciones', field: 'id', align: 'center' },
];

/**
 * Ejecucion vigente de un flujo, o `null` si no hay ninguna viva.
 *
 * Prefiere la del store, que es la que el canal mantiene al dia, y cae al dato
 * que ya trae la fila. Antes solo existia la primera via, y eso ataba el estado
 * pintado a que el socket hubiera entregado algo: tras un refresco de la pagina
 * la tabla no sabia que un flujo estaba detenido hasta el siguiente evento.
 */
const resolveExecution = (workflow: PipelineSummary): ExecutionSummary | null =>
  executionStore.executionByFlowId.get(workflow.id) ?? null;

/**
 * El flujo tiene una ejecucion detenida esperando decision.
 *
 * Se mira PRIMERO el estado de la fila: `status` es un hecho persistido que
 * sobrevive a un refresco, mientras que el del store depende de que el canal
 * haya entregado el evento. Se conserva la segunda via porque el backend marca
 * PAUSADO el flujo solo si estaba ACTIVO, y una ejecucion de un flujo que ya
 * estaba retirado sigue siendo reanudable.
 */
const isPaused = (workflow: PipelineSummary): boolean =>
  workflow.status === WorkflowStatus.PAUSADO ||
  workflow.executionState === ExecutionState.PAUSADO ||
  resolveExecution(workflow)?.state === ExecutionState.PAUSADO;

/** Identificador de la ejecucion detenida, venga del canal o de la fila. */
const resolveExecutionId = (workflow: PipelineSummary): string | null =>
  resolveExecution(workflow)?.executionId ?? workflow.activeExecutionId;

const loadCatalog = async (): Promise<void> => {
  try {
    // Las plantillas se piden en paralelo y con las retiradas incluidas: un
    // flujo puede venir de una que ya se retiro, y sin ella su procedencia
    // apareceria como desconocida.
    await Promise.all([workflowsStore.fetchWorkflows(), templatesStore.fetchTemplates(true)]);
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo cargar el catalogo de flujos'),
    });
  }
};

/**
 * Copia el identificador del flujo al portapapeles.
 *
 * El id ya estaba en la tabla, pero solo dentro de un tooltip: visible y no
 * seleccionable, que es la peor combinacion —se ve lo que hace falta y hay que
 * teclearlo a mano, con 36 caracteres y guiones—. Hace falta para la orden de
 * reanudacion por correo, para el soporte y para cualquier consulta contra la
 * base.
 *
 * El `catch` NO es ceremonia: el portapapeles exige contexto seguro (HTTPS o
 * localhost) y permiso del navegador, asi que falla de verdad en despliegues
 * por IP. Sin el, el operador se queda sin saber si copio o no.
 */
const copyWorkflowId = async (id: string): Promise<void> => {
  try {
    await copyToClipboard(id);
    $q.notify({
      type: 'positive',
      icon: 'check',
      message: 'ID de flujo copiado al portapapeles',
      timeout: 2000,
    });
  } catch {
    $q.notify({ type: 'negative', message: 'No se pudo copiar el ID' });
  }
};

/**
 * Ofrece las dos formas de reanudar una ejecucion detenida (CU-09 extendido).
 *
 * SIN temporizador de 5 segundos, a diferencia del descarte y de la baja del
 * flujo: aquel esta reservado a lo irreversible, y reanudar no destruye nada.
 * Lo que si hace falta es la eleccion, porque las dos opciones llevan a sitios
 * muy distintos —una ejecuta en el acto y la otra abre una vista— y hasta ahora
 * el boton disparaba el POST sin preguntar.
 *
 * La segunda opcion NO reanuda: navega al canvas con la ejecucion identificada
 * en la query, y es alli donde el operador elige el paso.
 */
const requestResume = (workflow: PipelineSummary): void => {
  const executionId = resolveExecutionId(workflow);

  if (executionId === null) {
    return;
  }

  $q.dialog({
    title: 'Reanudar ejecucion',
    message: 'Elige desde donde continuar el flujo detenido.',
    options: {
      type: 'radio',
      model: 'last',
      items: [
        { label: 'Reanudar desde el ultimo paso fallido', value: 'last' },
        { label: 'Elegir paso en el Canvas', value: 'canvas' },
      ],
    },
    cancel: { flat: true, label: 'Cancelar', class: 'pd-btn-secondary' },
    ok: { unelevated: true, label: 'Continuar', color: 'primary' },
    persistent: true,
  }).onOk((choice: string) => {
    if (choice === 'canvas') {
      void router.push({
        path: `/flujos/${workflow.id}`,
        query: { resume: 'true', execId: executionId },
      });

      return;
    }

    void resumeExecution(workflow);
  });
};

/**
 * Relanza la ejecucion detenida de un flujo (CU-09).
 *
 * El error se decide aqui y no en el store: la capa de negocio deja propagar la
 * excepcion y es el componente quien elige el mensaje
 * (`frontend-architecture.md` §2.1). El estado de la fila no se toca a mano
 * —lo repinta el evento `flow:resumed` que llega por el canal.
 */
const resumeExecution = async (workflow: PipelineSummary): Promise<void> => {
  // Por id y no por la ejecucion entera: tras un refresco de la pagina el store
  // todavia no ha recibido ningun evento, y lo unico que identifica la
  // ejecucion detenida es el campo que ya trae la fila.
  const executionId = resolveExecutionId(workflow);

  if (executionId === null) {
    return;
  }

  try {
    await executionStore.resumeExecution(executionId);
    $q.notify({ type: 'positive', message: 'Ejecucion reanudada' });
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo reanudar la ejecucion'),
    });
  }
};

/**
 * Abre el descarte de la ejecucion detenida de un flujo (CU-09).
 *
 * El cierre es la segunda salida de una PAUSADO: cuando la causa es
 * irrecuperable —un destino que ya no existe, un buzon dado de baja—, reanudar
 * solo repite el mismo fallo.
 */
const requestDiscard = (workflow: PipelineSummary): void => {
  const executionId = resolveExecutionId(workflow);

  if (executionId === null) {
    return;
  }

  // Se guarda el ID y no el resumen: el dialogo solo necesita a quien descartar,
  // y exigir el objeto completo dejaba el boton inerte tras un refresco.
  executionToDiscard.value = executionId;
  isDiscardDialogOpen.value = true;
};

/**
 * Cierra la ejecucion detenida y retira el flujo del sondeo.
 *
 * La invoca `SafeDeleteModal` tras su cuenta atras de cinco segundos. Ni la
 * fila de la ejecucion ni la del flujo se parchean a mano: las repintan
 * `flow:discarded` y la mutacion `crud:mutation` que el backend difunde, que es
 * ademas lo que mantiene al dia las pantallas de los demas operadores.
 */
const confirmDiscard = async (): Promise<void> => {
  const executionId = executionToDiscard.value;

  if (executionId === null) {
    return;
  }

  try {
    await executionStore.discardExecution(executionId);
    $q.notify({
      type: 'positive',
      message: 'Ejecucion descartada. El flujo queda inactivo.',
    });
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo descartar la ejecucion'),
    });
  } finally {
    executionToDiscard.value = null;
  }
};

const openEditDialog = (workflow: PipelineSummary): void => {
  editedWorkflow.value = workflow;
  isEditorOpen.value = true;
};

const onWorkflowSaved = (): void => {
  $q.notify({ type: 'positive', message: 'Flujo actualizado correctamente' });
};

const requestDeactivation = (workflow: PipelineSummary): void => {
  workflowToDeactivate.value = workflow;
  isDeleteDialogOpen.value = true;
};

/**
 * Retira el flujo de los disparadores automaticos.
 *
 * La invoca `SafeDeleteModal` tras su cuenta atras de 5 segundos, igual que la
 * baja logica de una cuenta en el CRUD de usuarios: desactivar corta la ingesta,
 * y un correo que llegue mientras el flujo esta retirado se queda en el buzon
 * sin procesar hasta que alguien lo note.
 */
const confirmDeactivation = async (): Promise<void> => {
  if (!workflowToDeactivate.value) return;

  try {
    await workflowsStore.setStatus(workflowToDeactivate.value.id, WorkflowStatus.INACTIVO);
    $q.notify({ type: 'positive', message: 'Flujo desactivado correctamente' });
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo desactivar el flujo'),
    });
  } finally {
    workflowToDeactivate.value = null;
  }
};

/**
 * Habilita el flujo frente a los disparadores automaticos.
 *
 * Directa y sin confirmacion, como la reactivacion de una cuenta en el CRUD de
 * usuarios: activar no destruye nada y es reversible. El unico riesgo real —un
 * grafo roto expuesto al sondeo— lo cubre el backend, que revalida el esquema
 * antes de habilitar y devuelve 400 si el flujo no tiene ninguno.
 *
 * El store escribe la respuesta del servidor y no un parche optimista, asi que
 * la fila se repinta con lo que de verdad quedo guardado y un 400 la deja como
 * estaba.
 */
const activateWorkflow = async (workflow: PipelineSummary): Promise<void> => {
  try {
    await workflowsStore.setStatus(workflow.id, WorkflowStatus.ACTIVO);
    $q.notify({
      type: 'positive',
      message: `Flujo "${workflow.name}" habilitado. El sondeo lo recogera en menos de un minuto.`,
    });
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo activar el flujo'),
    });
  }
};

/**
 * Entra en la sala de cada flujo del catalogo.
 *
 * Va DESPUES de cargar: hasta que no responde el listado no se sabe que salas
 * pedir. Un acuse negativo no interrumpe al resto —el gateway deniega una sala
 * por flujo inexistente o por tope de socket—, de modo que un flujo retirado
 * entre la carga y la suscripcion no deja la tabla a medio suscribir.
 */
const subscribeToCatalog = async (): Promise<void> => {
  await Promise.all(
    workflowsStore.workflows.map((workflow) => executionStore.joinFlow(workflow.id)),
  );
};

onMounted(async () => {
  await loadCatalog();
  await subscribeToCatalog();
});

// Las salas viven en el servidor: sin abandonarlas, el socket seguiria recibiendo
// la telemetria de todo el catalogo mucho despues de cerrar la tabla.
onBeforeUnmount(() => {
  void executionStore.leaveAllFlows();
});
</script>

<template>
  <q-page padding class="pd-page">
    <header class="workflows-header">
      <div>
        <h1 class="pd-h1">Flujos</h1>
        <p class="pd-subtitle">
          Flujos instanciados a partir de una plantilla. Cada uno lleva su propia copia de la
          topologia: editar la plantilla de origen no los altera.
        </p>
      </div>

      <q-btn
        class="pd-btn-primary"
        unelevated
        no-caps
        label="Nuevo Flujo"
        icon-right="north_east"
        to="/flujos/nuevo"
      />
    </header>

    <q-table
      class="pd-card pd-table"
      flat
      :rows="workflowsStore.workflows"
      :columns="columns"
      row-key="id"
      :loading="workflowsStore.isLoading"
      :filter="filter"
      no-results-label="Ningun resultado para la busqueda"
      no-data-label="Aun no hay flujos creados"
    >
      <template #top-right>
        <q-input
          v-model="filter"
          dense
          outlined
          clearable
          debounce="300"
          placeholder="Buscar..."
          class="pd-search-input"
          aria-label="Filtrar la tabla"
        >
          <template #append>
            <q-icon name="search" />
          </template>
        </q-input>
      </template>

      <template #body-cell-name="cellProps">
        <q-td :props="cellProps">
          {{ cellProps.value }}
          <!-- `.stop` porque la fila entera es pulsable: copiar no es abrir. -->
          <q-btn
            flat
            round
            dense
            size="xs"
            icon="content_copy"
            class="q-ml-xs pd-copy-id"
            data-test="copy-workflow-id"
            :aria-label="`Copiar el ID del flujo ${cellProps.value}`"
            @click.stop="copyWorkflowId(cellProps.row.id)"
          >
            <q-tooltip>Copiar ID de flujo</q-tooltip>
          </q-btn>
          <q-tooltip anchor="top middle" self="bottom middle">
            <span class="pd-mono">{{ cellProps.row.id }}</span>
          </q-tooltip>
        </q-td>
      </template>

      <template #body-cell-nodes="cellProps">
        <q-td :props="cellProps">
          <q-badge class="pd-badge pd-badge--role">{{ cellProps.value }}</q-badge>
          <q-tooltip v-if="cellProps.row.topology.length > 0">
            <span class="pd-mono">
              {{
                cellProps.row.topology.map((step: { nodeId: string }) => step.nodeId).join(' → ')
              }}
            </span>
          </q-tooltip>
        </q-td>
      </template>

      <!-- Badge informativo, igual que la columna Estado del CRUD de usuarios.
           Antes habia aqui un `q-toggle` que duplicaba la conmutacion con la
           botonera y, ademas, desactivaba un flujo en marcha con un solo clic
           saltandose el temporizador que exige CU-10. -->
      <!-- El estado de EJECUCION manda sobre el de habilitacion: a un operador
           le importa mas que el flujo este detenido ahora mismo que si quedo
           habilitado frente a los disparadores. Sin ejecucion viva se cae al
           badge de siempre.
           La pausa se decide con `isPaused`, que mira PRIMERO el `status` de la
           fila: ese es un hecho persistido que sobrevive a un refresco, mientras
           que el del store depende de que el canal haya entregado el evento. -->
      <template #body-cell-status="cellProps">
        <q-td :props="cellProps">
          <template v-if="isPaused(cellProps.row)">
            <!-- Antes `row-grave`, el TINTE de fila de la tabla de trazabilidad,
                 usado como badge: sin icono y con un contraste que no llegaba a
                 AA. Ahora el badge de pausa con su icono. -->
            <status-badge
              :display="describeWorkflowStatus(WorkflowStatus.PAUSADO)"
              data-test="status-paused"
            />
            <q-btn
              flat
              round
              dense
              icon="play_arrow"
              data-test="resume-execution"
              :loading="executionStore.isResuming"
              @click="requestResume(cellProps.row)"
            >
              <q-tooltip>Reanudar la ejecucion detenida (CU-09)</q-tooltip>
            </q-btn>
            <q-btn
              flat
              round
              dense
              icon="delete_sweep"
              color="negative"
              data-test="discard-execution"
              :loading="executionStore.isDiscarding"
              @click="requestDiscard(cellProps.row)"
            >
              <q-tooltip>Descartar la ejecucion: no se podra reanudar</q-tooltip>
            </q-btn>
            <q-tooltip>
              {{ resolveExecution(cellProps.row)?.failureReason ?? 'Ejecucion detenida' }}
            </q-tooltip>
          </template>

          <template
            v-else-if="
              resolveExecution(cellProps.row)?.state === ExecutionState.EN_PROCESO ||
              cellProps.row.executionState === ExecutionState.EN_PROCESO
            "
          >
            <status-badge
              :display="describeExecutionState(ExecutionState.EN_PROCESO)"
              data-test="status-running"
            />
            <q-spinner class="q-ml-xs" size="1em" />
            <q-tooltip>El motor esta recorriendo el pipeline ahora mismo</q-tooltip>
          </template>

          <template v-else>
            <status-badge
              :display="
                describeWorkflowStatus(
                  cellProps.row.status === WorkflowStatus.ACTIVO
                    ? WorkflowStatus.ACTIVO
                    : WorkflowStatus.INACTIVO,
                )
              "
            />
            <q-tooltip>
              {{
                cellProps.row.status === WorkflowStatus.ACTIVO
                  ? 'Habilitado frente a los disparadores automaticos'
                  : 'No se disparara hasta que lo habilites'
              }}
            </q-tooltip>
          </template>
        </q-td>
      </template>

      <template #body-cell-actions="cellProps">
        <q-td :props="cellProps" class="q-gutter-x-xs">
          <!-- Supervision: la topologia en vivo, de solo lectura. Va la
               primera porque es la accion no destructiva y la que se usa al
               recibir el aviso de una pausa. -->
          <q-btn
            class="pd-btn-icon"
            outline
            dense
            size="sm"
            icon="account_tree"
            :aria-label="`Supervisar ${cellProps.row.name}`"
            :to="`/flujos/${cellProps.row.id}`"
          >
            <q-tooltip>Ver la topologia y el estado en vivo</q-tooltip>
          </q-btn>

          <!-- Dos acciones y no una: el asistente edita la CONFIGURACION del
               pipeline (filtros, plantilla de cada nodo) y el dialogo se queda
               con el renombrado rapido, que no merece cargar un stepper. -->
          <q-btn
            class="pd-btn-icon"
            outline
            dense
            size="sm"
            icon="tune"
            :aria-label="`Configurar ${cellProps.row.name}`"
            :to="`/flujos/${cellProps.row.id}/editar`"
          >
            <q-tooltip>Configurar el pipeline en el asistente</q-tooltip>
          </q-btn>

          <q-btn
            class="pd-btn-icon"
            outline
            dense
            size="sm"
            icon="edit"
            :aria-label="`Renombrar ${cellProps.row.name}`"
            @click="openEditDialog(cellProps.row)"
          >
            <q-tooltip>Renombrar o cambiar la descripcion</q-tooltip>
          </q-btn>

          <!-- Mismo par excluyente que el CRUD de usuarios: desactivar pasa
               por la cuenta atras de `SafeDeleteModal`; activar es directo. -->
          <q-btn
            v-if="cellProps.row.status === WorkflowStatus.ACTIVO"
            class="pd-btn-icon pd-btn-icon--danger"
            outline
            dense
            size="sm"
            icon="block"
            :aria-label="`Desactivar ${cellProps.row.name}`"
            @click="requestDeactivation(cellProps.row)"
          >
            <q-tooltip>Desactivar flujo</q-tooltip>
          </q-btn>

          <q-btn
            v-else
            class="pd-btn-icon pd-btn-icon--positive"
            outline
            dense
            size="sm"
            icon="check_circle"
            :aria-label="`Activar ${cellProps.row.name}`"
            @click="activateWorkflow(cellProps.row)"
          >
            <q-tooltip>Activar flujo</q-tooltip>
          </q-btn>
          <!-- Ver mas: auditoria de la fila (migracion 045). Va la ultima
               porque es consulta, no accion. -->
          <AuditDetailsMenu :audit="cellProps.row" :subject="cellProps.row.name" />
        </q-td>
      </template>
    </q-table>

    <WorkflowDialog v-model="isEditorOpen" :workflow="editedWorkflow" @saved="onWorkflowSaved" />

    <!-- Desactivar un flujo en marcha corta la ingesta: pasa por el temporizador
         de 5 segundos como toda accion critica (regla §4). El interruptor de la
         tabla queda para el sentido contrario, habilitar, que no destruye nada. -->
    <SafeDeleteModal
      v-model="isDeleteDialogOpen"
      title="Desactivar flujo"
      :message="`¿Seguro que deseas desactivar el flujo ${workflowToDeactivate?.name ?? ''}? Dejara de procesar correos entrantes hasta que lo habilites de nuevo.`"
      confirm-label="Desactivar"
      @confirm="confirmDeactivation"
    />

    <!-- Descartar es IRREVERSIBLE —la ejecucion no vuelve a ser reanudable— y
         ademas apaga el flujo, asi que pasa por el mismo temporizador de cinco
         segundos que la desactivacion. Dos modales y no uno compartido: los
         dos pueden estar abiertos sobre filas distintas, y un unico `v-model`
         haria que abrir el segundo cerrase el primero. -->
    <SafeDeleteModal
      v-model="isDiscardDialogOpen"
      title="Descartar ejecucion pausada"
      message="Esta accion abortara definitivamente la ejecucion pausada y cambiara el estado del flujo a Inactivo. ¿Deseas continuar?"
      confirm-label="Descartar"
      @confirm="confirmDiscard"
    />
  </q-page>
</template>

<style scoped lang="scss">
.workflows-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

// Discreto hasta que se busca: el identificador es un dato de soporte, no una
// accion primaria de la tabla. `text-grey-N` queda descartado por §2.
.pd-copy-id {
  color: var(--pd-text-secondary);

  &:hover {
    color: var(--pd-accent);
  }
}
</style>
