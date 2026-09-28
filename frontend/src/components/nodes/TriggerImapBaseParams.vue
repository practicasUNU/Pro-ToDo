<script setup lang="ts">
interface Props {
  /** `params` actuales del nodo en la plantilla. Solo lectura: se emiten, no se mutan. */
  params: Record<string, unknown>;
  /** Identidad del nodo, para los `id`/`for` de los controles. */
  nodeId: string;
  /**
   * La topologia impone el valor y el operador no puede cambiarlo.
   *
   * Hoy lo activa la ruta de contingencia de vision IA, que lee los adjuntos de
   * `raw_email`: sin ellos el desvio llama al modelo con nada que leer, pasa la
   * validacion del backend y falla mudo en produccion.
   */
  locked: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:params': [params: Record<string, unknown>];
}>();

/**
 * Lectura DEFENSIVA del booleano.
 *
 * La comparacion estricta con `true` no es ceremonia: `configuracion_pipeline`
 * es una columna `jsonb` que pudo escribirse por SQL directo o por una version
 * anterior del editor, y una cadena `'false'` es *truthy* en JavaScript. Sin la
 * comparacion, un nodo guardado a mano encenderia el toggle y el operador veria
 * activada una ingesta que el backend interpreta como apagada.
 */
const includeAttachments = (): boolean => props.params.includeAttachments === true;

/**
 * Publica el objeto COMPLETO, no solo la clave que cambia.
 *
 * El spread conserva las claves que este control no gestiona —las que sembro
 * otra version del editor, o un `mailbox` retocado a mano en el espejo de la
 * derecha—: reconstruir `params` desde cero las borraria en silencio al
 * accionar un simple interruptor.
 */
const LOCKED_HINT =
  'Lo exige la ruta de contingencia de vision IA de este flujo: el desvio lee los adjuntos del correo, y sin ingerirlos el modelo no tendria nada que leer.';

const onToggle = (value: boolean): void => {
  emit('update:params', { ...props.params, includeAttachments: value });
};
</script>

<template>
  <div class="pd-base-params">
    <q-toggle
      :model-value="includeAttachments()"
      dense
      color="primary"
      label="Procesar adjuntos (imagenes/documentos <= 5 MB)"
      :aria-label="`Procesar adjuntos en ${props.nodeId}`"
      :disable="props.locked"
      data-test="include-attachments-toggle"
      @update:model-value="onToggle"
    />

    <!-- Se dice POR QUE esta bloqueado. Un control apagado sin explicacion se
         lee como una averia, y el operador buscaria el fallo donde no esta. -->
    <p v-if="props.locked" class="pd-subtitle q-mt-xs q-mb-none" data-test="locked-hint">
      {{ LOCKED_HINT }}
    </p>
    <p class="pd-subtitle q-mt-xs q-mb-none">
      Los adjuntos que superen el limite se descartan sin detener el flujo. El contenido binario se
      libera en cuanto algun nodo extrae texto aprovechable, asi que solo viaja hasta donde de
      verdad hace falta.
    </p>
  </div>
</template>

<style scoped lang="scss">
// Mismo tratamiento que `.pd-execution-policy` en el dialogo de plantillas: un
// bloque con relieve propio distingue un ajuste de comportamiento de los campos
// estructurales (namespace, orden) que lo rodean.
.pd-base-params {
  padding: 12px;
  border: 1px solid var(--pd-border);
  border-radius: 8px;
  background: var(--pd-surface-muted);
}
</style>
