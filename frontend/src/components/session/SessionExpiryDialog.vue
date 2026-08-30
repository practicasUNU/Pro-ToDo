<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useDialogPluginComponent } from 'quasar';

/** Antelacion del aviso: coincide con la que programa SessionMonitor.vue. */
const WARNING_SECONDS = 60;

interface Props {
  /** Segundos reales hasta la caducidad; permite abrir el aviso ya empezado. */
  secondsUntilExpiry?: number;
}

const props = withDefaults(defineProps<Props>(), {
  secondsUntilExpiry: WARNING_SECONDS,
});

defineEmits([...useDialogPluginComponent.emits]);

const { dialogRef, onDialogHide, onDialogOK, onDialogCancel } = useDialogPluginComponent();

const secondsRemaining = ref(Math.max(0, Math.round(props.secondsUntilExpiry)));

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

      // Llegar a cero equivale a no responder: se cierra la sesion. El diálogo
      // es `persistent`, asi que esta es la unica salida automatica.
      onDialogCancel();
      return;
    }

    secondsRemaining.value -= 1;
  }, 1000);
});

onBeforeUnmount(clearCountdown);
</script>

<template>
  <!-- persistent: la sesion esta a punto de caer, cerrar con Esc o clic fuera
       dejaria al usuario creyendo que sigue dentro -->
  <q-dialog ref="dialogRef" persistent @hide="onDialogHide">
    <q-card class="pd-dialog-card pd-card--accent pd-accent-grave">
      <q-card-section class="row items-center no-wrap q-gutter-sm">
        <span class="pd-icon-circle">
          <q-icon name="schedule" size="20px" class="pd-warning-icon" />
        </span>
        <div class="pd-h2">Tu sesion esta a punto de expirar</div>
      </q-card-section>

      <q-card-section class="q-pt-none pd-text-secondary">
        Por seguridad, la sesion se cerrara automaticamente cuando termine la cuenta atras.
      </q-card-section>

      <q-card-section class="q-pt-none text-center">
        <span class="pd-mono pd-countdown">{{ secondsRemaining }} segundos restantes</span>
      </q-card-section>

      <q-card-actions align="right" class="q-px-md q-pb-md">
        <q-btn flat no-caps label="Cerrar sesion" class="pd-btn-cancel" @click="onDialogCancel" />
        <q-btn
          class="pd-btn-primary"
          unelevated
          no-caps
          label="Mantener sesion"
          icon-right="north_east"
          @click="onDialogOK"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<style scoped lang="scss">
.pd-warning-icon {
  color: var(--pd-warning);
}

.pd-btn-cancel {
  color: var(--pd-text-secondary);
}

.pd-countdown {
  color: var(--pd-negative);
  font-size: 18px;
}
</style>
