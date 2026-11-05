<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useDialogPluginComponent } from 'quasar';

import type { ModifiedUserField } from '@/types/session-events';

/** Margen que se le da al usuario para leer el aviso antes de expulsarlo. */
const COUNTDOWN_SECONDS = 5;

interface Props {
  /** Correo de quien hizo el cambio: un cierre anonimo parece un fallo. */
  actorEmail: string;
  updatedFields: readonly ModifiedUserField[];
}

const props = defineProps<Props>();

defineEmits([...useDialogPluginComponent.emits]);

const { dialogRef, onDialogHide, onDialogOK } = useDialogPluginComponent();

const secondsRemaining = ref(COUNTDOWN_SECONDS);

/** «rol», «rol y estado», «rol, estado y correo». */
const describedFields = props.updatedFields.join(', ').replace(/, ([^,]*)$/, ' y $1');

let intervalId: ReturnType<typeof setInterval> | undefined;

const clearCountdown = (): void => {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = undefined;
  }
};

onMounted(() => {
  intervalId = setInterval(() => {
    if (secondsRemaining.value <= 1) {
      secondsRemaining.value = 0;
      clearCountdown();

      // Llegar a cero DISPARA el cierre, al reves que `SafeDeleteModal`, donde
      // la cuenta atras bloquea la accion hasta terminar. Aqui no hay nada que
      // confirmar: la sesion ya esta muerta en el servidor —`token_version` se
      // incremento antes de mandar el aviso— y estos cinco segundos solo
      // existen para que el usuario lea por que.
      onDialogOK();
      return;
    }

    secondsRemaining.value -= 1;
  }, 1000);
});

onBeforeUnmount(clearCountdown);
</script>

<template>
  <!-- persistent y SIN boton de escape: no es una decision del usuario. Cerrar
       con Esc o con un clic fuera le dejaria creyendo que sigue dentro de una
       sesion que el servidor ya no reconoce. -->
  <q-dialog ref="dialogRef" persistent @hide="onDialogHide">
    <q-card class="pd-dialog-card pd-card--accent pd-accent-urgente">
      <q-card-section class="row items-center no-wrap q-gutter-sm">
        <span class="pd-icon-circle">
          <q-icon name="manage_accounts" size="20px" class="pd-negative-icon" />
        </span>
        <div class="pd-h2">Tu cuenta ha sido modificada</div>
      </q-card-section>

      <q-card-section class="q-pt-none pd-text-secondary" data-test="forced-logout-message">
        Lo sentimos mucho, tu cuenta ha sido modificada en los campos
        ({{ describedFields }}) por {{ actorEmail }}. Por motivos de seguridad, tu
        sesión se cerrará en {{ COUNTDOWN_SECONDS }} segundos.
      </q-card-section>

      <q-card-section class="q-pt-none text-center">
        <span class="pd-mono pd-countdown" data-test="forced-logout-countdown">
          {{ secondsRemaining }} segundos restantes
        </span>
      </q-card-section>
    </q-card>
  </q-dialog>
</template>

<style scoped lang="scss">
.pd-negative-icon {
  color: var(--pd-negative);
}

.pd-countdown {
  color: var(--pd-negative);
  font-size: 1.125rem;
}
</style>
