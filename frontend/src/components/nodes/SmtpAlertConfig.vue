<script setup lang="ts">
import { computed } from 'vue';

import { useSmtpAlertStore } from '@stores/nodes/smtp-alert.store';

import { useRecipientsInput } from '@/composables/useRecipientsInput';
import { isEmailAddress } from '@/utils/email-address';

import { NODE_TYPE_LABELS, NodeType } from '@/types/pipeline';
import {
  DEFAULT_ALERT_SUBJECT,
  MAX_ALERT_NOTE_LENGTH,
  MAX_ALERT_RECIPIENTS,
  MAX_ALERT_SUBJECT_LENGTH,
} from '@/types/nodes/smtp-alert.types';

interface Props {
  /** Identificador del nodo en el `pipeline_schema` (contrato uniforme §3.1). */
  nodeId: string;
}

const props = defineProps<Props>();

// El store se resuelve POR NODO: dos alertas en el mismo flujo —una al equipo
// tecnico, otra al responsable del contenido— tienen cada una sus destinatarios.
const store = useSmtpAlertStore(props.nodeId);

// Mensajes como constantes: varios los comparten la regla del campo y la ayuda
// bajo el input, y duplicarlos los dejaria divergir.
const RECIPIENTS_HINT = `Escribe una direccion y pulsa Enter o coma para anadirla. Hasta ${MAX_ALERT_RECIPIENTS} destinatarios.`;

const RECIPIENTS_RULE = 'Todas las direcciones deben tener formato de correo valido';

const SUBJECT_HINT =
  'Admite texto libre o variables dinamicas {{namespace.campo}}. Si lo dejas en blanco se usara el asunto por defecto, y si una variable no existe en el flujo el aviso se envia igualmente con un asunto de respaldo.';

const NOTE_HINT =
  'Texto libre que se incrustara como nota tecnica en la carta de alerta generada automaticamente. Es TEXTO PLANO: un {{...}} escrito aqui sale literal.';

const BODY_NOTICE =
  'El cuerpo del correo no se configura: lo compone el sistema con la identidad institucional y los datos del fallo (nodo, codigo, nivel y payload parcial) que el motor deja en el contexto al desviar el flujo.';

const FREE_TEXT_NOTICE =
  'Este es uno de los dos campos del proyecto con entrada libre en un selector. No puede haber lista cerrada de direcciones de correo, asi que la validez la decide la regla del campo.';

/** Direcciones invalidas, nombradas una a una en vez de con un aviso generico. */
const invalidSummary = computed<string>(() => store.invalidRecipients.join(', '));

// Las tres vias de entrada (teclear, salir del campo, pegar) viven en el
// composable: el nodo de pausa programada pide exactamente lo mismo, y una
// segunda copia de estas politicas habria divergido en silencio.
const {
  typed: typedRecipient,
  commitTyped: commitTypedAddress,
  onKeydown: onRecipientKeydown,
  onPaste: onPasteRecipients,
} = useRecipientsInput({
  current: () => store.config.to,
  commit: (to) => {
    store.updateConfig({ to });
  },
  max: MAX_ALERT_RECIPIENTS,
});
</script>

<template>
  <section class="pd-card q-pa-md" :data-node-id="nodeId">
    <header class="row items-center no-wrap q-gutter-sm q-mb-md">
      <span class="pd-icon-circle">
        <q-icon name="mark_email_unread" size="20px" class="pd-node-icon" />
      </span>
      <div>
        <div class="pd-h2">{{ NODE_TYPE_LABELS[NodeType.DESTINO_SMTP] }}</div>
        <div class="pd-subtitle">
          Avisa por correo de lo que ocurre en el flujo. Es el destino natural de una ruta de error
          declarada con onErrorStep.
        </div>
      </div>
    </header>

    <div class="row q-col-gutter-md items-start">
      <!-- Selector con entrada libre. La excepcion a §4 esta razonada en el
           banner de abajo: no existe ni puede existir una lista cerrada de
           direcciones de correo. -->
      <div class="col-12 col-md-6" data-test="recipients-field">
        <label class="pd-label" for="smtp-alert-to">
          Destinatarios<span class="pd-required">*</span>
        </label>
        <q-select
          id="smtp-alert-to"
          :model-value="store.config.to"
          outlined
          dense
          multiple
          use-input
          use-chips
          hide-dropdown-icon
          new-value-mode="add"
          input-debounce="0"
          class="q-mt-xs"
          :max-values="MAX_ALERT_RECIPIENTS"
          :hint="RECIPIENTS_HINT"
          :rules="[
            (val: string[]) => val.length > 0 || 'Indica al menos un destinatario',
            (val: string[]) => val.every(isEmailAddress) || RECIPIENTS_RULE,
          ]"
          @update:model-value="store.updateConfig({ to: [...($event as string[])] })"
          @input-value="typedRecipient = $event"
          @keydown="onRecipientKeydown"
          @blur="commitTypedAddress"
          @paste="onPasteRecipients"
        />
      </div>
    </div>

    <!-- Nombra las direcciones concretas: con chips, decir "hay un correo mal"
         obliga a revisarlos todos a ojo. -->
    <q-banner
      v-if="store.invalidRecipients.length > 0"
      dense
      class="pd-invalid-banner q-mt-md"
      role="alert"
      data-test="invalid-recipients"
    >
      <template #avatar>
        <q-icon name="error_outline" size="20px" class="pd-invalid-icon" />
      </template>
      <div class="pd-label pd-invalid-title">{{ RECIPIENTS_RULE }}</div>
      <p class="pd-subtitle pd-mono q-mb-none">{{ invalidSummary }}</p>
    </q-banner>

    <div class="q-mt-md" data-test="subject-field">
      <label class="pd-label" for="smtp-alert-subject">Asunto del correo</label>
      <q-input
        id="smtp-alert-subject"
        :model-value="store.config.subject"
        outlined
        dense
        clearable
        class="q-mt-xs pd-mono"
        :placeholder="DEFAULT_ALERT_SUBJECT"
        :maxlength="MAX_ALERT_SUBJECT_LENGTH"
        :hint="SUBJECT_HINT"
        @update:model-value="store.updateConfig({ subject: String($event ?? '') })"
      />
    </div>

    <div class="q-mt-md" data-test="custom-message-field">
      <label class="pd-label" for="smtp-alert-note">Nota para el destinatario</label>
      <q-input
        id="smtp-alert-note"
        :model-value="store.config.customMessage"
        type="textarea"
        rows="3"
        outlined
        dense
        counter
        class="q-mt-xs"
        :maxlength="MAX_ALERT_NOTE_LENGTH"
        :hint="NOTE_HINT"
        @update:model-value="store.updateConfig({ customMessage: String($event ?? '') })"
      />
    </div>

    <q-banner dense class="pd-info-banner q-mt-md">
      <template #avatar>
        <q-icon name="auto_awesome" size="20px" class="pd-node-icon" />
      </template>
      <p class="pd-subtitle q-mb-xs">{{ BODY_NOTICE }}</p>
      <p class="pd-subtitle q-mb-none">{{ FREE_TEXT_NOTICE }}</p>
    </q-banner>

    <!-- Vista previa ESTRUCTURAL, no una replica de la carta.
         Imitar sus colores y textos crearia una segunda plantilla en otro
         lenguaje que diverge en cuanto alguien toque el generador del backend, y
         entonces la vista previa mentiria. Lo que el operador necesita saber es
         DONDE cae su nota, no como se ve el gris exacto del pie. -->
    <h3 class="pd-h2 q-mt-lg q-mb-xs">Como se vera el aviso</h3>
    <p class="pd-subtitle q-mb-md">
      Esquema de la carta que recibira el destinatario. Los bloques en gris los rellena el motor con
      los datos de la ejecucion.
    </p>

    <div class="pd-mail-mock" data-test="letter-preview">
      <div class="pd-mail-mock__header">
        <span>UNUWARE &middot; Proto-Do</span>
      </div>

      <div class="pd-mail-mock__body">
        <span class="pd-mail-mock__badge">GRAVE</span>
        <div class="pd-mail-mock__title">Flujo detenido</div>
        <div class="pd-mail-mock__slot">Nodo que fallo y motivo del desvio</div>

        <div class="pd-mail-mock__note">
          <div class="pd-mail-mock__note-label">Tu nota</div>
          <p class="pd-mail-mock__note-text">
            {{
              store.config.customMessage.trim() || 'Aqui se incrustara la nota que escribas arriba'
            }}
          </p>
        </div>

        <div class="pd-mail-mock__slot">Diagnostico tecnico: codigo, nivel, flujo y fecha</div>
        <div class="pd-mail-mock__slot pd-mail-mock__slot--code">
          Datos parciales del nodo (JSON)
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.pd-node-icon {
  color: var(--pd-primary);
}

.pd-invalid-icon {
  color: var(--pd-negative);
}

.pd-invalid-title {
  color: var(--pd-negative);
}

.pd-info-banner {
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-border);
  border-radius: $generic-border-radius;
  color: var(--pd-text-primary);
}

.pd-invalid-banner {
  background: var(--pd-row-urgente);
  border: 1px solid var(--pd-negative);
  border-radius: $generic-border-radius;
  color: var(--pd-text-primary);
}

// Maqueta del correo. Usa los tokens del sistema y NO los hex de la carta real:
// esto se lee dentro de la aplicacion, que si conmuta con el tema.
.pd-mail-mock {
  border: 1px solid var(--pd-border);
  border-radius: $generic-border-radius;
  overflow: hidden;
  background: var(--pd-surface-muted);
}

.pd-mail-mock__header {
  background: var(--pd-gradient);
  color: var(--pd-text-primary);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.075rem;
  text-transform: uppercase;
  padding: 12px 16px;
}

.pd-mail-mock__body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pd-mail-mock__badge {
  align-self: flex-start;
  background: var(--pd-warning);
  color: var(--pd-shell-bg);
  border-radius: 999px;
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.0625rem;
  padding: 3px 10px;
}

.pd-mail-mock__title {
  color: var(--pd-text-primary);
  font-size: 1rem;
  font-weight: 700;
}

// Recuadro punteado: se lee como "esto lo rellena el sistema", no como un campo.
.pd-mail-mock__slot {
  border: 1px dashed var(--pd-border);
  border-radius: $generic-border-radius;
  color: var(--pd-text-secondary);
  font-size: 0.75rem;
  padding: 10px 12px;
}

.pd-mail-mock__slot--code {
  background: var(--pd-page-bg);
  font-family: 'JetBrains Mono Variable', 'Fira Code', monospace;
}

.pd-mail-mock__note {
  background: var(--pd-card-bg);
  border-left: 3px solid var(--pd-primary);
  border-radius: $generic-border-radius;
  padding: 10px 12px;
}

.pd-mail-mock__note-label {
  color: var(--pd-text-secondary);
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.0625rem;
  text-transform: uppercase;
  margin-bottom: 4px;
}

.pd-mail-mock__note-text {
  color: var(--pd-text-primary);
  font-size: 0.8125rem;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

// Campos e inputs sobre los tokens del sistema (regla §2, Formularios). Quinta
// copia del mismo bloque; candidato claro a subir a app.scss.
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

// Chips de destinatario sobre los tokens de acento, como los chips de variable
// del mapeador.
:deep(.q-chip) {
  background: var(--pd-surface-muted);
  color: var(--pd-accent-text);
  border: 1px solid var(--pd-border);
}
</style>
