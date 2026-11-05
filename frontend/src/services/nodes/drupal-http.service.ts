import { api } from '@boot/axios';

import type { DrupalPresetTargets } from '@/types/nodes/drupal-http.types';

// Frontera HTTP del nodo DESTINO_DRUPAL (regla frontend-quasar.md §3.1).
//
// Una sola ruta, de solo lectura: las paginas de los destinos rapidos, que el
// backend lee de su `.env`. Que hacer con ellas lo decide el store, y el aviso
// al usuario si fallan, el componente.

/** Paginas (UUID y NID) de cada preset en los dos entornos. */
export const fetchDrupalPresetTargets = async (): Promise<DrupalPresetTargets> => {
  const { data } = await api.get<DrupalPresetTargets>('/nodos/drupal/targets');

  return data;
};
