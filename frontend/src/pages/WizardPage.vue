<script setup lang="ts">
import { computed, onMounted, reactive } from 'vue';
import { useQuasar } from 'quasar';
import { useRoute, useRouter } from 'vue-router';

import { useFlujoDraftStore } from '@stores/flujo-draft.store';

import { nodeConfigRegistry } from '@components/nodes/node-config-registry';
import NodeBranchCard from '@components/nodes/common/NodeBranchCard.vue';
import NodeErrorBranchConfig from '@components/nodes/common/NodeErrorBranchConfig.vue';
import SmtpAlertConfig from '@components/nodes/SmtpAlertConfig.vue';
import PipelineSelector from '@components/wizard/PipelineSelector.vue';
import SaveWarningsDialog from '@components/wizard/SaveWarningsDialog.vue';

import { extractApiErrorMessage } from '@/utils/api-error';

import { NodeType } from '@/types/pipeline';
import { MULTIMODAL_FALLBACK_CODE, SHARED_ALERT_NODE_ID } from '@/types/nodes/error-branch.types';

import type { StepWarning } from '@stores/flujo-draft.store';
import type { WizardStep } from '@/types/pipeline';
import type { Component } from 'vue';

const $q = useQuasar();
const route = useRoute();
const router = useRouter();
const draftStore = useFlujoDraftStore();

/**
 * Flujo que se esta editando, o `null` en un alta.
 *
 * El modo lo decide la RUTA y no una prop: `flujos/:id/editar` monta esta misma
 * pagina, y derivarlo del parametro evita una segunda fuente de verdad que
 * pudiera contradecir a la barra de direcciones.
 */
const editedWorkflowId = computed<string | null>(() => {
  const { id } = route.params;

  return typeof id === 'string' && id !== '' ? id : null;
});

const isEditMode = computed<boolean>(() => editedWorkflowId.value !== null);

/**
 * Indice del paso de revision: uno mas que el ultimo paso configurable.
 *
 * Se deriva del store y no de la longitud de la topologia porque entre el ultimo
 * nodo y la revision puede haber un paso mas —el de contingencias—, que tampoco
 * corresponde a ningun nodo del grafo.
 */
const reviewStepIndex = computed<number>(() => draftStore.configurableStepCount);

const isReviewStep = computed<boolean>(() => draftStore.activeStep === reviewStepIndex.value);

/**
 * Nodo que recibe la recuperacion funcional de un paso, o `null`.
 *
 * Devuelve `null` tambien cuando la rama es una alerta: esa es terminal y se
 * configura en el paso de contingencias, no junto al nodo que la declara.
 */
const branchTargetFor = (nodeId: string): string | null => {
  if (!draftStore.hasContextualRecoveryBranch(nodeId)) return null;

  const branch = draftStore.getNodeErrorBranch(nodeId);

  return branch === null ? null : draftStore.resolveBranchTarget(branch.action);
};

/** Datos del flujo a crear; se piden al final, no al principio. */
const form = reactive<{ name: string; description: string }>({
  name: '',
  description: '',
});

/**
 * Fase 0 mientras no haya plantilla elegida; Fase 1..N en cuanto la hay.
 *
 * En EDICION no se muestra nunca: el flujo ya existe y su topologia es la que
 * es. Ofrecer ahi el selector permitiria cambiarle la plantilla de origen a un
 * flujo ya instanciado, que es justo lo que `UpdateWorkflowDto` impide al no
 * declarar `templateId`.
 */
const isSelectingTemplate = computed<boolean>(
  () => !isEditMode.value && draftStore.selectedTemplateId === null,
);

/** Rotulo de la accion final, distinto en cada modo. */
const submitLabel = computed<string>(() => (isEditMode.value ? 'Guardar cambios' : 'Crear Flujo'));

/**
 * Configurador del paso indicado, o `null` si su tipo aun no tiene uno.
 *
 * Resolucion polimorfica por `nodeType` (regla §3.1): esta funcion es la UNICA
 * via por la que el anfitrion decide que montar, y no hay ni un `v-if` por tipo
 * de nodo en la plantilla. Anadir un tipo es anadir una entrada al registro.
 */
const resolveStepComponent = (step: WizardStep): Component | null =>
  nodeConfigRegistry[step.nodeType] ?? null;

const loadTemplates = async (): Promise<void> => {
  try {
    await draftStore.loadAvailableTemplates();
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudieron cargar las plantillas'),
    });
  }
};

const onSelectTemplate = (templateId: string): void => {
  draftStore.selectTemplate(templateId);
};

const onBackToSelector = (): void => {
  draftStore.resetDraft();
};

/**
 * Avanza al paso de revision desde el ultimo nodo configurado.
 *
 * Antes salia con un `return` mudo si el paso no era valido: el operador pulsaba
 * y no ocurria absolutamente nada, sin ninguna pista de que faltaba.
 */
const onGoToReview = (): void => {
  if (!draftStore.isActiveStepValid) {
    notifyActiveStepBlocked();
    return;
  }

  draftStore.activeStep = reviewStepIndex.value;
};

/**
 * Motivo por el que este paso no es ejecutable, o `null` si lo es.
 *
 * Solo devuelve los motivos IRRECUPERABLES: que falten campos por rellenar no
 * es un problema del nodo y ya lo dice su propio formulario.
 */
const unsupportedReasonFor = (step: WizardStep): string | null => {
  const blocked = draftStore.invalidSteps.find((item) => item.step.nodeId === step.nodeId);

  return blocked !== undefined && blocked.reason !== 'CONFIGURACION_INCOMPLETA'
    ? blocked.message
    : null;
};

/** Explica por que el paso activo no deja avanzar. */
const notifyActiveStepBlocked = (): void => {
  const blocked = draftStore.invalidSteps.find((item) => item.index === draftStore.activeStep);

  $q.notify({
    type: 'warning',
    message: blocked?.message ?? 'Completa la configuracion de este paso para continuar.',
  });
};

/**
 * Pide confirmacion antes de guardar con avisos pendientes.
 *
 * `$q.dialog` devuelve un `DialogChainObject` y NO una promesa, asi que hay que
 * envolverlo: sin esto `onSaveWorkflow` seguiria su curso y persistiria el flujo
 * mientras el dialogo sigue abierto, sin haber esperado la respuesta.
 */
const confirmSaveWithWarnings = (warnings: readonly StepWarning[]): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    $q.dialog({ component: SaveWarningsDialog, componentProps: { warnings } })
      .onOk(() => {
        resolve(true);
      })
      .onCancel(() => {
        resolve(false);
      })
      // Esc o clic fuera se resuelven como cancelacion. `onDismiss` corre
      // TAMBIEN tras ok/cancel, pero una promesa ya resuelta ignora la segunda
      // llamada; sin esta rama, cerrar sin decidir la dejaria colgada.
      .onDismiss(() => {
        resolve(false);
      });
  });

const onSaveWorkflow = async (): Promise<void> => {
  const editing = isEditMode.value;

  // El nombre se comprueba AQUI y ya no en el `:disable` del boton. Con el
  // nombre vacio y todos los pasos validos, el boton quedaba deshabilitado y el
  // aviso de pasos pendientes no se pintaba —porque no habia ninguno—, asi que
  // pulsar Guardar no producia nada en absoluto: ni peticion, ni mensaje, ni
  // error en consola. Ese era el fallo silencioso.
  if (form.name.trim() === '') {
    $q.notify({ type: 'warning', message: 'El nombre del flujo es obligatorio.' });
    document.getElementById('workflow-name')?.focus();
    return;
  }

  // Los avisos no bloquean, pero tampoco pasan desapercibidos: es la ultima
  // oportunidad de ver una conexion sin comprobar antes de persistirla. El
  // configurador del nodo solo esta montado mientras su paso es el activo, y
  // aqui ya no lo esta, asi que su aviso en linea no basta.
  if (draftStore.stepWarnings.length > 0) {
    const confirmed = await confirmSaveWithWarnings(draftStore.stepWarnings);

    // Cancelar no notifica nada: el operador acaba de leer por que vuelve.
    if (!confirmed) return;
  }

  try {
    const saved = await draftStore.assembleAndSaveWorkflow(form.name.trim(), form.description);

    $q.notify({
      type: 'positive',
      // Guardar una edicion NO cambia el estado del flujo: `active` no viaja en
      // el cuerpo, asi que prometer que "queda inactivo" seria falso para un
      // flujo que ya estaba habilitado.
      message: editing
        ? `Flujo "${saved.name}" actualizado.`
        : `Flujo "${saved.name}" creado. Queda INACTIVO hasta que lo habilites.`,
    });

    // El borrador se limpia antes de navegar: si el operador vuelve al
    // asistente, debe empezar de cero y no sobre los restos del flujo anterior.
    draftStore.resetDraft();
    form.name = '';
    form.description = '';

    // A `/flujos` y no a la portada: ahi aparece el flujo recien creado y ahi
    // esta el toggle con el que se habilita.
    await router.push('/flujos');
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(
        error,
        editing ? 'No se pudo guardar el flujo' : 'No se pudo crear el flujo',
      ),
    });
  }
};

/**
 * Trae el flujo a editar y reparte su configuracion a los stores de nodo.
 *
 * Rellena tambien el formulario final: en edicion el nombre y la descripcion no
 * se piden en blanco, se corrigen sobre los que el flujo ya tiene.
 */
const loadWorkflowForEdit = async (workflowId: string): Promise<void> => {
  try {
    const workflow = await draftStore.loadWorkflowForEdit(workflowId);

    form.name = workflow.name;
    form.description = workflow.description ?? '';
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo cargar el flujo'),
    });
    await router.push('/flujos');
  }
};

onMounted(async () => {
  const workflowId = editedWorkflowId.value;

  // El catalogo de plantillas solo hace falta para la Fase 0 del alta.
  await (workflowId === null ? loadTemplates() : loadWorkflowForEdit(workflowId));
});
</script>

<template>
  <q-page class="pd-page q-pa-md">
    <PipelineSelector
      v-if="isSelectingTemplate"
      :templates="draftStore.availableTemplates"
      :is-loading="draftStore.isLoading"
      @select="onSelectTemplate"
    />

    <section v-else>
      <div class="row items-center no-wrap q-gutter-sm q-mb-md">
        <div>
          <h1 class="pd-h1 q-mb-none">
            {{ isEditMode ? form.name : draftStore.selectedTemplate?.name }}
          </h1>
          <p class="pd-subtitle q-mb-none">
            Paso {{ draftStore.activeStep + 1 }} de {{ reviewStepIndex + 1 }}
            <span v-if="isReviewStep"> · revision final</span>
          </p>
        </div>
        <q-space />
        <!-- Solo en alta: en edicion `resetDraft()` vaciaria el borrador recien
             hidratado, y ademas cambiar la plantilla de un flujo ya instanciado
             no es una operacion que el backend admita. -->
        <q-btn
          v-if="!isEditMode"
          flat
          no-caps
          class="pd-btn-secondary"
          label="Cambiar plantilla"
          icon="arrow_back"
          @click="onBackToSelector"
        />
        <q-btn
          v-else
          flat
          no-caps
          class="pd-btn-secondary"
          label="Volver al catalogo"
          icon="arrow_back"
          to="/flujos"
        />
      </div>

      <q-stepper v-model="draftStore.activeStep" class="pd-card" vertical animated flat keep-alive>
        <q-step
          v-for="(step, index) in draftStore.pipelineTopology"
          :key="step.nodeId"
          :name="index"
          :title="step.name"
          :caption="step.outputNamespace"
          :prefix="index + 1"
          :done="index < draftStore.activeStep"
        >
          <!-- Un tipo con configurador pero SIN store es el caso enganoso: el
               formulario se pinta con normalidad y el guardado queda bloqueado
               para siempre sin que nada lo explique. Se avisa encima del propio
               configurador en vez de ocultarlo, para que se vea que el problema
               no es lo que hay escrito en los campos. -->
          <div
            v-if="unsupportedReasonFor(step)"
            class="pd-card pd-card--accent pd-accent-grave q-pa-md q-mb-md"
            role="alert"
          >
            <div class="pd-h2">Nodo no ejecutable</div>
            <p class="pd-subtitle q-mt-xs q-mb-none">{{ unsupportedReasonFor(step) }}</p>
          </div>

          <!-- Resolucion polimorfica: cero condicionales por tipo de nodo. -->
          <component
            :is="resolveStepComponent(step)"
            v-if="resolveStepComponent(step)"
            :node-id="step.nodeId"
          />

          <!-- El registro es `Partial` a proposito: un tipo sin configurador
               avisa en vez de romper la vista. -->
          <div v-else class="pd-card pd-card--accent pd-accent-grave q-pa-md" role="alert">
            <div class="pd-h2">Configurador no disponible</div>
            <p class="pd-subtitle q-mt-xs q-mb-none">
              El nodo <span class="pd-mono">{{ step.nodeId }}</span> es de tipo
              <span class="pd-mono">{{ step.nodeType }}</span
              >, que todavia no tiene interfaz de configuracion. No se puede continuar mas alla de
              este paso.
            </p>
          </div>

          <!-- Ruta de contingencia del paso. Se monta AQUI, en el anfitrion, y
               no dentro de cada configurador: el registro pasa solo `node-id`, y
               meterlo en los seis obligaria a editarlos todos y a que cada tipo
               nuevo se acordase. Una sola insercion lo da para todos.

               No se ofrece sobre un nodo de alerta: se desviaria a si mismo. -->
          <NodeErrorBranchConfig
            v-if="resolveStepComponent(step) && step.nodeType !== NodeType.DESTINO_SMTP"
            :node-id="step.nodeId"
            :node-type="step.nodeType"
          />

          <!-- Recuperacion FUNCIONAL: el flujo sigue por otra via en vez de
               avisar a una persona. Se dibuja junto al paso que la declara
               porque es ahi donde tiene sentido leerla, pero el nodo destino se
               configura en su propio paso: esta en el camino normal del flujo y
               pintar aqui su formulario lo mostraria dos veces. -->
          <NodeBranchCard
            v-if="branchTargetFor(step.nodeId)"
            :source-node-id="step.nodeId"
            :target-node-id="branchTargetFor(step.nodeId) ?? ''"
            :error-code="MULTIMODAL_FALLBACK_CODE"
          />

          <q-stepper-navigation class="row items-center q-gutter-sm">
            <q-btn
              v-if="!draftStore.isFirstStep"
              flat
              no-caps
              class="pd-btn-secondary"
              label="Anterior"
              @click="draftStore.goToPreviousStep()"
            />
            <q-space />
            <q-btn
              v-if="!draftStore.isLastStep"
              class="pd-btn-primary"
              unelevated
              no-caps
              label="Siguiente"
              icon-right="north_east"
              :disable="!draftStore.isActiveStepValid"
              @click="draftStore.goToNextStep()"
            />
            <!-- En el ultimo nodo el avance va al paso de revision, que no es un
                 nodo del pipeline y por eso no lo cubre `goToNextStep`. -->
            <q-btn
              v-else
              class="pd-btn-primary"
              unelevated
              no-caps
              label="Revisar y guardar"
              icon-right="north_east"
              :disable="!draftStore.isActiveStepValid"
              @click="onGoToReview"
            />
          </q-stepper-navigation>
        </q-step>

        <!-- Paso de contingencias: tampoco es un nodo del grafo, y solo aparece
             si alguna rama provisiona el nodo de alerta compartido. Los
             destinatarios se piden UNA vez aqui y no dentro de cada panel de
             rama, donde antes se repetian tantas veces como rutas hubiera. -->
        <q-step
          v-if="draftStore.hasAlertContingencyStep"
          :name="draftStore.alertStepIndex"
          title="Contingencias por correo"
          caption="Destinatarios de las alertas"
          :prefix="draftStore.alertStepIndex + 1"
          icon="crisis_alert"
        >
          <SmtpAlertConfig :node-id="SHARED_ALERT_NODE_ID" />

          <q-stepper-navigation class="row items-center q-gutter-sm">
            <q-btn
              flat
              no-caps
              class="pd-btn-secondary"
              label="Anterior"
              @click="draftStore.goToPreviousStep()"
            />
            <q-space />
            <q-btn
              class="pd-btn-primary"
              unelevated
              no-caps
              label="Revisar y guardar"
              icon-right="north_east"
              :disable="!draftStore.isActiveStepValid"
              @click="onGoToReview"
            />
          </q-stepper-navigation>
        </q-step>

        <!-- Paso terminal: no corresponde a ningun nodo del grafo. Los datos del
             flujo se piden AQUI y no al principio para que el operador no tenga
             que nombrar algo que todavia no ha configurado. -->
        <q-step
          :name="reviewStepIndex"
          title="Revision y guardado"
          caption="Nombre, descripcion y resumen"
          :prefix="reviewStepIndex + 1"
          icon="fact_check"
        >
          <div class="row q-col-gutter-md">
            <div class="col-12 col-md-6">
              <label class="pd-label" for="workflow-name">
                Nombre del flujo<span class="pd-required">*</span>
              </label>
              <q-input
                id="workflow-name"
                v-model="form.name"
                outlined
                dense
                class="q-mt-xs"
                maxlength="100"
                placeholder="Notiweb - publicacion automatica"
                :rules="[(val: string) => !!val?.trim() || 'El nombre es obligatorio']"
              />
            </div>

            <div class="col-12 col-md-6">
              <label class="pd-label" for="workflow-description">Descripcion</label>
              <q-input
                id="workflow-description"
                v-model="form.description"
                outlined
                dense
                class="q-mt-xs"
                maxlength="255"
                placeholder="Que hace este flujo y cuando se dispara"
              />
            </div>
          </div>

          <div class="pd-surface-muted pd-review-summary q-pa-md q-mt-md">
            <div class="pd-label q-mb-sm">Topologia configurada</div>
            <ol class="pd-review-summary__list">
              <li v-for="step in draftStore.pipelineTopology" :key="step.nodeId">
                <span class="pd-review-summary__name">{{ step.name }}</span>
                <span class="pd-mono pd-review-summary__ns">
                  {{ step.nodeId }} → {{ step.outputNamespace }}
                </span>
              </li>
            </ol>
          </div>

          <!-- Aviso, no sorpresa: el flujo nace inactivo por decision de
               seguridad y el operador debe saberlo antes de pulsar. -->
          <div class="pd-card pd-card--accent pd-accent-leve q-pa-md q-mt-md">
            <p class="pd-subtitle q-mb-none">
              <template v-if="isEditMode">
                Guardar no cambia el estado del flujo: se conserva tal y como esta en el catalogo.
              </template>
              <template v-else>
                El flujo se creara <strong>inactivo</strong>. No consumira el buzon hasta que lo
                habilites de forma explicita.
              </template>
            </p>
          </div>

          <!-- Cada paso pendiente, con su motivo y clicable para ir a el. Antes
               era una sola linea con las etiquetas de los tipos, que con dos
               nodos del mismo tipo resultaba ambigua y nunca decia POR QUE. -->
          <div v-if="!draftStore.canSave" class="pd-blocked-panel q-mb-md" role="alert">
            <div class="pd-label">
              {{
                draftStore.hasUnsupportedNodes
                  ? 'Este flujo no se puede guardar tal cual'
                  : 'Faltan pasos por completar'
              }}
            </div>
            <ul class="pd-blocked-list q-mt-xs q-mb-none">
              <li v-for="item in draftStore.invalidSteps" :key="item.index">
                <button
                  type="button"
                  class="pd-blocked-link"
                  @click="draftStore.activeStep = item.index"
                >
                  {{ item.step.name }}
                </button>
                <span class="pd-subtitle">— {{ item.message }}</span>
              </li>
            </ul>
          </div>

          <q-stepper-navigation class="row items-center q-gutter-sm">
            <q-btn
              flat
              no-caps
              class="pd-btn-secondary"
              label="Anterior"
              @click="draftStore.goToPreviousStep()"
            />
            <q-space />
            <!-- El nombre NO entra en el `:disable`: si lo hiciera, un nombre
                 vacio con todos los pasos validos dejaria el boton muerto y sin
                 ningun aviso. Lo comprueba `onSaveWorkflow`, que siempre se
                 ejecuta y siempre responde algo. -->
            <q-btn
              class="pd-btn-primary"
              unelevated
              no-caps
              :label="submitLabel"
              icon-right="north_east"
              :disable="!draftStore.canSave"
              :loading="draftStore.isLoading"
              @click="onSaveWorkflow"
            />
          </q-stepper-navigation>
        </q-step>
      </q-stepper>
    </section>
  </q-page>
</template>

<style scoped lang="scss">
// El stepper consume el token de superficie elevada (regla §2).
:deep(.q-stepper) {
  background: var(--pd-card-bg);
  color: var(--pd-text-primary);
}

:deep(.q-stepper__title) {
  color: var(--pd-text-primary);
}

:deep(.q-stepper__caption) {
  color: var(--pd-text-secondary);
  font-family: $mono-font-family;
}

:deep(.q-stepper__tab--disabled) {
  color: var(--pd-disabled-text);
}

.pd-review-summary {
  border: 1px solid var(--pd-border);
  border-radius: $generic-border-radius;

  &__list {
    margin: 0;
    padding-left: 20px;
    color: var(--pd-text-primary);

    li {
      margin-bottom: 6px;
    }
  }

  &__name {
    font-weight: 500;
  }

  &__ns {
    display: block;
    color: var(--pd-text-secondary);
  }
}

// Panel de pasos que impiden guardar. Sustituye al `.pd-review-hint`, que era
// una linea suelta a la derecha del boton y no cabia con el motivo de cada paso.
.pd-blocked-panel {
  padding: 12px 16px;
  border: 1px solid var(--pd-border);
  border-radius: 8px;
  background: var(--pd-surface-muted);
}

.pd-blocked-list {
  padding-left: 18px;
  color: var(--pd-text-secondary);
}

.pd-blocked-link {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--pd-accent-text);
  cursor: pointer;
  text-decoration: underline;
}
</style>
