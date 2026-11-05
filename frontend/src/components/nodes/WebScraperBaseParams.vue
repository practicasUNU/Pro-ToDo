<script setup lang="ts">
interface Props {
  /** `params` actuales del nodo en la plantilla. Solo lectura: se emiten, no se mutan. */
  params: Record<string, unknown>;
  /** Identidad del nodo, para los `id`/`for` de los controles. */
  nodeId: string;
  /**
   * La topologia impone el valor y el operador no puede cambiarlo.
   *
   * Hoy ninguna ruta de contingencia fija este parametro, asi que llega siempre
   * en `false`; se honra igualmente porque es el contrato uniforme del registro
   * (`node-base-params-registry.ts`) y no una particularidad de aquel nodo.
   */
  locked: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:params': [params: Record<string, unknown>];
}>();

const LOCKED_HINT =
  'Lo fija la topologia de este flujo. Cambiarlo aqui desactivaria la contingencia que hace que la ruta sirva para algo.';

/**
 * Lectura DEFENSIVA del booleano, y en el sentido CONTRARIO al de IMAP.
 *
 * `includeAttachments` es un opt-IN cuyo defecto es `false`, y por eso aquel
 * compara con `=== true`. Este es un opt-OUT cuyo defecto es `true`
 * —`DEFAULT_SCRAPER_SKIP_IF_EMPTY`—, de modo que la unica lectura fiel es
 * "apagado solo si alguien lo apago expresamente". Con `=== true` un nodo recien
 * creado, o una plantilla anterior a este campo, mostraria el toggle apagado
 * mientras el backend lo aplica encendido.
 *
 * La comparacion estricta sigue haciendo falta: `configuracion_pipeline` es una
 * columna `jsonb` que pudo escribirse por SQL directo, y la cadena `'false'` es
 * *truthy* en JavaScript.
 */
const skipIfEmpty = (): boolean => props.params.skipIfEmpty !== false;

/**
 * Publica el objeto COMPLETO, no solo la clave que cambia.
 *
 * El spread conserva las claves que este control no gestiona —las que sembro
 * otra version del editor, o un `targetUrl` retocado a mano en el espejo de la
 * derecha—: reconstruir `params` desde cero las borraria en silencio al accionar
 * un simple interruptor.
 */
const onToggle = (value: boolean): void => {
  emit('update:params', { ...props.params, skipIfEmpty: value });
};
</script>

<template>
  <div class="pd-base-params">
    <q-toggle
      :model-value="skipIfEmpty()"
      dense
      color="primary"
      label="Omitir extraccion si la URL no existe (contingencia OCR)"
      :aria-label="`Omitir extraccion sin URL en ${props.nodeId}`"
      :disable="props.locked"
      data-test="skip-if-empty-base-toggle"
      @update:model-value="onToggle"
    />

    <!-- Se dice POR QUE esta bloqueado. Un control apagado sin explicacion se
         lee como una averia, y el operador buscaria el fallo donde no esta. -->
    <p v-if="props.locked" class="pd-subtitle q-mt-xs q-mb-none" data-test="locked-hint">
      {{ LOCKED_HINT }}
    </p>
    <p class="pd-subtitle q-mt-xs q-mb-none">
      Activado, un flujo que no traiga enlaces —una contingencia por OCR, o un correo sin URLs— se
      salta este paso y continua con los campos de
      <span class="pd-mono">scraped_web</span> en blanco, en vez de detenerse. Apagado, el flujo
      exige que algun paso anterior publique una direccion y se niega a guardarse sin ella.
    </p>
  </div>
</template>

<style scoped lang="scss">
// Mismo tratamiento que `.pd-base-params` en el control del disparador IMAP: un
// bloque con relieve propio distingue un ajuste de comportamiento de los campos
// estructurales (namespace, orden) que lo rodean.
.pd-base-params {
  padding: 12px;
  border: 1px solid var(--pd-border);
  border-radius: 8px;
  background: var(--pd-surface-muted);
}
</style>
