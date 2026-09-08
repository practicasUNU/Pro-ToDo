import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as triggerImapService from '@services/nodes/trigger-imap.service';

import type { CheckImapPayload, CheckImapResult } from '@/types/pipeline';

/** Puerto IMAPS por defecto (TLS implicito), el mismo que asume el backend. */
export const DEFAULT_IMAP_PORT = 993;

/** Buzon por defecto. */
export const DEFAULT_MAILBOX = 'INBOX';

/** Periodo de sondeo por defecto: un minuto. */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/**
 * Periodo minimo de sondeo, replicado del `@Min(30000)` del DTO backend.
 *
 * Sin esta copia, el formulario dejaria enviar un valor que el backend rechaza
 * con un 400: el operador veria un error de servidor donde deberia haber visto
 * una regla de campo.
 */
export const MIN_POLL_INTERVAL_MS = 30_000;

/**
 * Claves de entorno admisibles para `passwordEnvKey`.
 *
 * Replica del patron del backend, y no es cosmetica en ninguno de los dos lados:
 * sin ella se podria declarar `passwordEnvKey: JWT_SECRET` y pedir al servidor
 * que enviase el secreto de firma de tokens a un host arbitrario como si fuera
 * una contrasena de buzon. Aqui evita ademas gastar una llamada de red en una
 * peticion que el backend va a rechazar.
 */
export const PASSWORD_ENV_KEY_PATTERN = /^IMAP_[A-Z0-9_]*PASSWORD$/;

/** `params` que el nodo aporta al `pipeline_schema`. */
export interface TriggerImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  passwordEnvKey: string;
  mailbox: string;
  pollIntervalMs: number;
}

/** Configuracion inicial; se reutiliza en `resetConfig`. */
const buildInitialConfig = (): TriggerImapConfig => ({
  host: '',
  port: DEFAULT_IMAP_PORT,
  secure: true,
  user: '',
  passwordEnvKey: '',
  mailbox: DEFAULT_MAILBOX,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
});

// Estado reactivo del nodo TRIGGER_IMAP (regla frontend-quasar.md §3.1).
// No conoce Axios ni rutas: delega en su servicio y expone `isConfigValid`, que
// es lo unico que el asistente consulta para habilitar el avance.
export const useTriggerImapStore = defineStore('triggerImapNode', () => {
  const config = ref<TriggerImapConfig>(buildInitialConfig());

  /**
   * La conexion se ha probado con exito para los valores ACTUALES del formulario.
   *
   * Se invalida en cuanto cambia cualquier campo de conexion (ver `patchConfig`).
   * Sin eso, probar con un host correcto, cambiarlo por uno invalido y avanzar
   * dejaria pasar una configuracion que nunca se comprobo, que es justo el fallo
   * que este paso del asistente existe para evitar.
   */
  const connectionVerified = ref(false);

  const isLoading = ref(false);

  /** Ultimo resultado devuelto por el backend, para que la vista lo muestre. */
  const lastCheckResult = ref<CheckImapResult | null>(null);

  /** Campos completos y con formato admisible, sin considerar la conexion. */
  const hasValidFields = computed<boolean>(
    () =>
      config.value.host.trim() !== '' &&
      config.value.user.trim() !== '' &&
      config.value.mailbox.trim() !== '' &&
      PASSWORD_ENV_KEY_PATTERN.test(config.value.passwordEnvKey) &&
      Number.isInteger(config.value.port) &&
      config.value.port > 0 &&
      config.value.port <= 65_535 &&
      Number.isInteger(config.value.pollIntervalMs) &&
      config.value.pollIntervalMs >= MIN_POLL_INTERVAL_MS,
  );

  /**
   * Contrato uniforme del nodo. Exige dos cosas:
   *
   * 1. Que los campos esten completos y bien formados.
   * 2. Que la conexion se haya PROBADO con exito contra el servidor real.
   *
   * El segundo requisito es el Poka-Yoke del paso: unas credenciales con formato
   * correcto pero equivocadas no fallarian hasta que el sondeo disparase el
   * flujo en produccion. Obligar a probar traslada ese descubrimiento al momento
   * de configurar.
   */
  const isConfigValid = computed<boolean>(() => hasValidFields.value && connectionVerified.value);

  /** Payload de la comprobacion, derivado de la configuracion actual. */
  const checkPayload = computed<CheckImapPayload>(() => ({
    host: config.value.host.trim(),
    port: config.value.port,
    secure: config.value.secure,
    user: config.value.user.trim(),
    passwordEnvKey: config.value.passwordEnvKey.trim(),
    mailbox: config.value.mailbox.trim(),
    pollIntervalMs: config.value.pollIntervalMs,
  }));

  /**
   * Aplica un cambio parcial e INVALIDA la verificacion previa.
   *
   * Toda mutacion pasa por aqui para que no exista ninguna via de modificar la
   * configuracion sin invalidar la prueba: si la vista escribiera en `config`
   * directamente, `connectionVerified` quedaria mintiendo.
   */
  const patchConfig = (patch: Partial<TriggerImapConfig>): void => {
    config.value = { ...config.value, ...patch };
    connectionVerified.value = false;
    lastCheckResult.value = null;
  };

  /**
   * Prueba las credenciales contra el servidor de correo.
   *
   * No captura la excepcion: el store solo garantiza el `finally` que apaga
   * `isLoading`, y es el componente quien decide el mensaje al usuario
   * (`frontend-architecture.md` §2.1).
   */
  const testConnection = async (): Promise<CheckImapResult> => {
    isLoading.value = true;

    try {
      const result = await triggerImapService.checkImapConnection(checkPayload.value);

      lastCheckResult.value = result;
      connectionVerified.value = result.success;

      return result;
    } finally {
      isLoading.value = false;
    }
  };

  const resetConfig = (): void => {
    config.value = buildInitialConfig();
    connectionVerified.value = false;
    lastCheckResult.value = null;
  };

  return {
    config,
    connectionVerified,
    isLoading,
    lastCheckResult,
    hasValidFields,
    isConfigValid,
    checkPayload,
    patchConfig,
    testConnection,
    resetConfig,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTriggerImapStore, import.meta.hot));
}
