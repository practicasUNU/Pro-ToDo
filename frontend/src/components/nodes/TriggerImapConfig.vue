<script setup lang="ts">
import { computed } from 'vue';
import { useQuasar } from 'quasar';

import {
  MIN_POLL_INTERVAL_MS,
  PASSWORD_ENV_KEY_PATTERN,
  SUBJECT_REGEX_RULE,
  isValidRegexPattern,
  useTriggerImapStore,
} from '@stores/nodes/trigger-imap.store';

import { extractApiErrorMessage } from '@/utils/api-error';

import type { SubjectMatchMode } from '@/utils/subject-filter-mode';

interface Props {
  /** Identificador del nodo en el `pipeline_schema` (contrato uniforme §3.1). */
  nodeId: string;
}

const props = defineProps<Props>();

const $q = useQuasar();
// El store se resuelve POR NODO: dos disparadores IMAP en el mismo flujo tienen
// cada uno su propia configuracion, no una compartida.
const store = useTriggerImapStore(props.nodeId);

// Mensajes de regla como constantes: el mismo texto lo usan la regla del campo y
// la ayuda bajo el input, y duplicarlo los dejaria divergir.
const PASSWORD_ENV_KEY_HINT =
  'Solo se admiten variables con el formato IMAP_*PASSWORD. La contrasena vive en el .env del servidor: aqui se declara unicamente el NOMBRE de la variable.';

const POLL_INTERVAL_HINT = `El backend rechaza periodos por debajo de ${MIN_POLL_INTERVAL_MS / 1000} s para no exceder los limites de tasa del proveedor IMAP.`;

const FILTER_HINT = 'Coincidencia por subcadena. Dejalo vacio para no filtrar.';

const SUBJECT_REGEX_HINT =
  'Expresion regular sobre el asunto completo (ej. ^S_2026_.*). El correo que no coincida se descarta sin ejecutar el flujo.';

/**
 * Modos de coincidencia ofrecidos, en el orden en que se espera que se usen.
 *
 * El modo NO es un campo del nodo: no se guarda en `params` (el DTO del backend
 * valida con `forbidNonWhitelisted`) sino que se deduce de la forma del patron
 * al abrir un flujo. Ver `@/utils/subject-filter-mode`.
 */
const SUBJECT_MODE_OPTIONS: readonly { label: string; value: SubjectMatchMode }[] = [
  { label: 'Contiene texto', value: 'CONTAINS' },
  { label: 'Empieza por', value: 'STARTS_WITH' },
];

const SUBJECT_CONTAINS_HINT =
  'Escribe palabras clave separadas por comas, ej: licitacion, convocatoria. Basta con que el asunto contenga una de ellas; no se distinguen mayusculas de minusculas.';

const SUBJECT_STARTS_WITH_HINT =
  'El asunto debe EMPEZAR por este texto, ej: S_2026_. No se distinguen mayusculas de minusculas.';

const SUBJECT_ADVANCED_NOTICE =
  'Al escribir una expresion regular a mano dejas de usar los modos asistidos: el texto de arriba se sustituye por lo que escribas aqui.';

/** Ayuda del campo asistido, segun el modo activo. */
const subjectDraftHint = computed(() =>
  store.subjectMatchMode === 'STARTS_WITH' ? SUBJECT_STARTS_WITH_HINT : SUBJECT_CONTAINS_HINT,
);

/** Rotulo del campo asistido, segun el modo activo. */
const subjectDraftLabel = computed(() =>
  store.subjectMatchMode === 'STARTS_WITH' ? 'El asunto empieza por' : 'El asunto contiene',
);

/** Marcador de posicion del campo asistido, segun el modo activo. */
const subjectDraftPlaceholder = computed(() =>
  store.subjectMatchMode === 'STARTS_WITH' ? 'S_2026_' : 'licitacion, convocatoria',
);

/**
 * El patron efectivo, para mostrarlo bajo los modos asistidos.
 *
 * Es lo que de verdad se guarda, y enseñarlo evita que el modo asistido sea una
 * caja negra: el operador que quiera afinarlo sabe con que parte en el acordeon
 * de modo avanzado.
 */
const effectiveSubjectPattern = computed(() => store.config.subjectFilterRegex);

const UNREAD_ONLY_WARNING =
  'Con el filtro desactivado el flujo puede volver a procesar un correo ya leido en cada sondeo.';

const ATTACHMENTS_LOCKED_HINT = 'Activado obligatoriamente por la plantilla de flujo.';

const ATTACHMENTS_HINT =
  'Los adjuntos que superen el limite se descartan sin detener el flujo. El contenido binario se libera en cuanto algun nodo extrae texto aprovechable.';

const UNTESTED_BLOCKING_HINT =
  'Prueba la conexion para continuar. Si configuras sin servidor de correo alcanzable, marca la casilla para avanzar bajo tu responsabilidad.';

const UNTESTED_ACKNOWLEDGED_HINT =
  'Vas a guardar unas credenciales que nadie ha verificado: si son incorrectas, no fallaran hasta el primer sondeo.';

const SKIP_CHECK_TOOLTIP =
  'El paso no avanza hasta que la conexion se pruebe con exito o declares que configuras sin comprobarla.';

/**
 * Estado del indicador de conexion, derivado del ultimo resultado del backend.
 *
 * El tercer estado —"sin comprobar"— no es cosmetico: es lo que ve el operador
 * que avanza por la via reconocida, y decir en voz alta "vas a guardar unas
 * credenciales que nadie ha verificado" es justamente lo que evita que esa via
 * se convierta en la costumbre.
 */
/**
 * La plantilla impone la ingesta de adjuntos y el operador no puede apagarla.
 *
 * Lo decide el STORE y no una prop: es un hecho de la topologia del flujo —la
 * ruta de contingencia de vision IA lee `raw_email.attachments`— y sobrevive a
 * que el operador navegue a otro paso del asistente y vuelva.
 */
const isAttachmentsLocked = computed<boolean>(() =>
  store.isFieldLockedByTemplate('includeAttachments'),
);

const connectionBadge = computed<{ label: string; classes: string } | null>(() => {
  if (store.connectionVerified) {
    return { label: 'Conexion verificada', classes: 'pd-check-badge--ok' };
  }

  if (store.lastCheckResult?.success === false) {
    return { label: 'Conexion fallida', classes: 'pd-check-badge--fail' };
  }

  if (store.hasValidFields) {
    return { label: 'Sin comprobar', classes: 'pd-check-badge--warn' };
  }

  return null;
});

/**
 * Prueba las credenciales y traduce el resultado a una notificacion.
 *
 * El store no captura el error a proposito (`frontend-architecture.md` §2.1):
 * decidir el mensaje es competencia de la vista. Se distinguen dos fallos
 * distintos: el que el servidor de correo diagnostica (llega como 200 con
 * `success: false`) y el que rompe la llamada al backend (excepcion).
 */
const onTestConnection = async (): Promise<void> => {
  try {
    const result = await store.testConnection();

    if (result.success) {
      $q.notify({
        type: 'positive',
        message: result.message ?? 'Conexion exitosa',
      });
      return;
    }

    $q.notify({
      type: 'negative',
      message: `[${result.error?.level ?? 'GRAVE'}] ${
        result.error?.message ?? 'No se pudo conectar con el buzon'
      }`,
    });
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo comprobar la conexion IMAP'),
    });
  }
};
</script>

<template>
  <section class="pd-card q-pa-md" :data-node-id="nodeId">
    <header class="row items-center no-wrap q-gutter-sm q-mb-md">
      <span class="pd-icon-circle">
        <q-icon name="mark_email_unread" size="20px" class="pd-node-icon" />
      </span>
      <div>
        <div class="pd-h2">Disparador IMAP</div>
        <div class="pd-subtitle">
          Lee el correo no leido mas reciente del buzon e inicia el flujo.
        </div>
      </div>
      <q-space />
      <q-badge v-if="connectionBadge" class="pd-badge" :class="connectionBadge.classes">
        {{ connectionBadge.label }}
      </q-badge>
    </header>

    <div class="row q-col-gutter-md">
      <div class="col-12 col-md-8">
        <label class="pd-label" for="imap-host">
          Servidor IMAP<span class="pd-required">*</span>
        </label>
        <q-input
          id="imap-host"
          :model-value="store.config.host"
          outlined
          dense
          class="q-mt-xs"
          placeholder="imap.unuware.com"
          :rules="[(val: string) => !!val?.trim() || 'El servidor es obligatorio']"
          @update:model-value="store.patchConfig({ host: String($event ?? '') })"
        />
      </div>

      <div class="col-12 col-md-4">
        <label class="pd-label" for="imap-port"> Puerto<span class="pd-required">*</span> </label>
        <q-input
          id="imap-port"
          :model-value="store.config.port"
          type="number"
          outlined
          dense
          class="q-mt-xs"
          :rules="[
            (val: number) => Number.isInteger(val) || 'El puerto debe ser un numero entero',
            (val: number) => (val > 0 && val <= 65535) || 'Puerto fuera de rango (1-65535)',
          ]"
          @update:model-value="store.patchConfig({ port: Number($event) })"
        />
      </div>

      <div class="col-12 col-md-8">
        <label class="pd-label" for="imap-user">
          Usuario del buzon<span class="pd-required">*</span>
        </label>
        <q-input
          id="imap-user"
          :model-value="store.config.user"
          outlined
          dense
          class="q-mt-xs"
          placeholder="notiweb@unuware.com"
          :rules="[(val: string) => !!val?.trim() || 'El usuario es obligatorio']"
          @update:model-value="store.patchConfig({ user: String($event ?? '') })"
        />
      </div>

      <div class="col-12 col-md-4">
        <label class="pd-label" for="imap-mailbox"> Buzon<span class="pd-required">*</span> </label>
        <q-input
          id="imap-mailbox"
          :model-value="store.config.mailbox"
          outlined
          dense
          class="q-mt-xs"
          :rules="[(val: string) => !!val?.trim() || 'El buzon es obligatorio']"
          @update:model-value="store.patchConfig({ mailbox: String($event ?? '') })"
        />
      </div>

      <div class="col-12">
        <label class="pd-label" for="imap-password-env-key">
          Variable de entorno con la contrasena<span class="pd-required">*</span>
        </label>
        <q-input
          id="imap-password-env-key"
          :model-value="store.config.passwordEnvKey"
          outlined
          dense
          class="q-mt-xs pd-mono"
          placeholder="IMAP_PASSWORD"
          :hint="PASSWORD_ENV_KEY_HINT"
          :rules="[
            (val: string) => !!val?.trim() || 'La variable es obligatoria',
            (val: string) => PASSWORD_ENV_KEY_PATTERN.test(val ?? '') || PASSWORD_ENV_KEY_HINT,
          ]"
          @update:model-value="store.patchConfig({ passwordEnvKey: String($event ?? '') })"
        />
      </div>

      <div class="col-12 col-md-6">
        <label class="pd-label" for="imap-poll-interval">
          Periodo de sondeo (ms)<span class="pd-required">*</span>
        </label>
        <q-input
          id="imap-poll-interval"
          :model-value="store.config.pollIntervalMs"
          type="number"
          outlined
          dense
          class="q-mt-xs"
          :hint="POLL_INTERVAL_HINT"
          :rules="[
            (val: number) =>
              (Number.isInteger(val) && val >= MIN_POLL_INTERVAL_MS) || POLL_INTERVAL_HINT,
          ]"
          @update:model-value="store.patchConfig({ pollIntervalMs: Number($event) })"
        />
      </div>

      <div class="col-12 col-md-6 flex items-center">
        <q-toggle
          :model-value="store.config.secure"
          color="primary"
          label="Conexion cifrada (TLS implicito)"
          @update:model-value="store.patchConfig({ secure: Boolean($event) })"
        />
      </div>
    </div>

    <!-- Filtros de disparo. Separados de la conexion porque no participan en la
         comprobacion de credenciales: editarlos no invalida una prueba correcta
         (de ahi `patchFilters` y no `patchConfig`). -->
    <h3 class="pd-h2 q-mt-lg q-mb-sm">Filtros de disparo</h3>
    <p class="pd-subtitle q-mb-md">
      Acotan que correo arranca el flujo. Sin filtros, cualquier mensaje del buzon lo dispara.
    </p>

    <div class="row q-col-gutter-md">
      <div class="col-12 col-md-6">
        <label class="pd-label" for="imap-from-filter">Remitente contiene</label>
        <q-input
          id="imap-from-filter"
          :model-value="store.config.fromFilter"
          outlined
          dense
          clearable
          class="q-mt-xs"
          placeholder="redaccion@noticias.es"
          :hint="FILTER_HINT"
          @update:model-value="store.patchFilters({ fromFilter: String($event ?? '') })"
        />
      </div>

      <div class="col-12 col-md-6">
        <label class="pd-label" for="imap-subject-filter">Asunto contiene</label>
        <q-input
          id="imap-subject-filter"
          :model-value="store.config.subjectFilter"
          outlined
          dense
          clearable
          class="q-mt-xs"
          placeholder="Notiweb"
          :hint="FILTER_HINT"
          @update:model-value="store.patchFilters({ subjectFilter: String($event ?? '') })"
        />
      </div>

      <!-- Coincidencia del asunto. El modo se ELIGE (Poka-Yoke §4) y el patron
           se compone solo; la expresion regular queda relegada al acordeon. -->
      <div class="col-12 col-md-4" data-test="subject-match-mode">
        <label class="pd-label" for="imap-subject-match-mode">Modo de coincidencia</label>
        <q-select
          id="imap-subject-match-mode"
          :model-value="store.subjectMatchMode"
          :options="SUBJECT_MODE_OPTIONS"
          outlined
          dense
          emit-value
          map-options
          class="q-mt-xs"
          :disable="store.subjectMatchMode === 'ADVANCED'"
          @update:model-value="store.setSubjectMatchMode($event as SubjectMatchMode)"
        />
      </div>

      <div
        v-if="store.subjectMatchMode !== 'ADVANCED'"
        class="col-12 col-md-8"
        data-test="subject-match-draft"
      >
        <label class="pd-label" for="imap-subject-match-draft">{{ subjectDraftLabel }}</label>
        <q-input
          id="imap-subject-match-draft"
          :model-value="store.subjectMatchDraft"
          outlined
          dense
          clearable
          class="q-mt-xs"
          :placeholder="subjectDraftPlaceholder"
          :hint="subjectDraftHint"
          @update:model-value="store.setSubjectMatchDraft(String($event ?? ''))"
        />
        <p v-if="effectiveSubjectPattern !== ''" class="pd-subtitle q-mt-xs q-mb-none">
          Patron aplicado:
          <span class="pd-mono" data-test="subject-effective-pattern">
            {{ effectiveSubjectPattern }}
          </span>
        </p>
      </div>

      <div class="col-12">
        <q-expansion-item
          dense
          dense-toggle
          icon="code"
          label="Modo avanzado / Expresion regular"
          :model-value="store.subjectMatchMode === 'ADVANCED'"
          data-test="subject-advanced-panel"
          @update:model-value="store.setSubjectMatchMode($event ? 'ADVANCED' : 'CONTAINS')"
        >
          <div class="q-pt-sm" data-test="subject-filter-regex">
            <p class="pd-subtitle q-mb-sm">{{ SUBJECT_ADVANCED_NOTICE }}</p>
            <label class="pd-label" for="imap-subject-filter-regex">
              Asunto coincide con la expresion
            </label>
            <!--
              Sin `debounce`: el store es la unica fuente de verdad del boton
              "Siguiente" del asistente, y un retardo abre una ventana real en la
              que el usuario teclea un patron invalido y avanza antes de que el
              evento llegue a `hasValidFields`.
            -->
            <q-input
              id="imap-subject-filter-regex"
              :model-value="store.config.subjectFilterRegex"
              outlined
              dense
              clearable
              class="q-mt-xs pd-mono"
              placeholder="^S_2026_.*"
              :hint="SUBJECT_REGEX_HINT"
              :rules="[(val: string) => !val || isValidRegexPattern(val) || SUBJECT_REGEX_RULE]"
              @update:model-value="store.setAdvancedSubjectPattern(String($event ?? ''))"
            />
          </div>
        </q-expansion-item>
      </div>

      <div class="col-12">
        <q-toggle
          :model-value="store.config.unreadOnly"
          color="primary"
          label="Solo correos sin leer"
          @update:model-value="store.patchFilters({ unreadOnly: Boolean($event) })"
        />
        <p v-if="!store.config.unreadOnly" class="pd-subtitle q-mt-xs q-mb-none">
          {{ UNREAD_ONLY_WARNING }}
        </p>
      </div>

      <div class="col-12">
        <q-toggle
          :model-value="store.config.includeAttachments"
          color="primary"
          label="Procesar adjuntos (imagenes/documentos <= 5 MB)"
          :disable="isAttachmentsLocked"
          data-test="include-attachments-toggle"
          @update:model-value="store.patchConfig({ includeAttachments: Boolean($event) })"
        />
        <!-- Se dice POR QUE esta bloqueado: un control apagado sin explicacion
             se lee como una averia, y el operador buscaria el fallo donde no
             esta. -->
        <p
          v-if="isAttachmentsLocked"
          class="pd-subtitle q-mt-xs q-mb-none"
          data-test="attachments-locked-hint"
        >
          {{ ATTACHMENTS_LOCKED_HINT }}
        </p>
        <p v-else-if="store.config.includeAttachments" class="pd-subtitle q-mt-xs q-mb-none">
          {{ ATTACHMENTS_HINT }}
        </p>
      </div>
    </div>

    <!-- Poka-Yoke con salida. El paso no avanza sin probar la conexion, porque
         unas credenciales bien formadas pero equivocadas no fallarian hasta el
         primer sondeo en produccion. Pero la exigencia SIN salida ya se intento
         y hubo que retirarla: dejaba sin poder crear un flujo IMAP en cualquier
         entorno sin servidor alcanzable. De ahi la casilla: no es un atajo, es
         una declaracion explicita que ademas sigue viajando al dialogo de
         confirmacion del guardado. -->
    <div v-if="store.hasValidFields && !store.connectionVerified" class="q-mt-md">
      <p
        class="pd-subtitle q-mb-sm"
        :class="store.skipCheckAcknowledged ? 'pd-test-hint--warn' : 'pd-test-hint--blocking'"
      >
        {{ store.skipCheckAcknowledged ? UNTESTED_ACKNOWLEDGED_HINT : UNTESTED_BLOCKING_HINT }}
      </p>
      <q-checkbox
        v-model="store.skipCheckAcknowledged"
        dense
        class="pd-skip-check"
        label="Configurar sin comprobar la conexion"
      />
    </div>

    <div class="row items-center justify-end q-gutter-sm q-mt-md">
      <q-btn
        class="pd-btn-primary"
        unelevated
        no-caps
        label="Probar Conexion"
        icon-right="north_east"
        :disable="!store.hasValidFields"
        :loading="store.isLoading"
        @click="onTestConnection"
      >
        <q-tooltip v-if="!store.connectionVerified">
          {{ SKIP_CHECK_TOOLTIP }}
        </q-tooltip>
      </q-btn>
    </div>
  </section>
</template>

<style scoped lang="scss">
.pd-node-icon {
  color: var(--pd-primary);
}

.pd-check-badge--warn {
  background: var(--pd-warning);
  color: var(--pd-shell-bg);
}

.pd-test-hint--warn {
  color: var(--pd-warning);
}

.pd-test-hint--blocking {
  color: var(--pd-negative);
}

.pd-skip-check {
  color: var(--pd-text-secondary);
}

.pd-check-badge--ok {
  background: var(--pd-positive);
  color: #ffffff;
}

.pd-check-badge--fail {
  background: var(--pd-negative);
  color: #ffffff;
}

// Campos e inputs sobre los tokens del sistema (regla §2, Formularios). Mismo
// bloque que en los dialogos del gestor; candidato a subir a app.scss cuando se
// pueda tocar componentes ajenos a esta rama.
:deep(.q-field--outlined .q-field__control) {
  background: var(--pd-card-bg);
}

:deep(.q-field--outlined .q-field__control::before) {
  border-color: var(--pd-border);
}

:deep(.q-field__native::placeholder) {
  color: var(--pd-text-secondary);
}

:deep(.q-field__messages) {
  color: var(--pd-text-secondary);
}
</style>
