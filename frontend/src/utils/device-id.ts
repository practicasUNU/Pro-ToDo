import { LocalStorage } from 'quasar';

const DEVICE_ID_KEY = 'proto-do:device-id';

/** Identificador estable del dispositivo/navegador. Se genera una sola vez y persiste. */
export const getOrCreateDeviceId = (): string => {
  const existing = LocalStorage.getItem<string>(DEVICE_ID_KEY);
  if (existing) return existing;

  const deviceId = crypto.randomUUID();
  LocalStorage.set(DEVICE_ID_KEY, deviceId);
  return deviceId;
};
