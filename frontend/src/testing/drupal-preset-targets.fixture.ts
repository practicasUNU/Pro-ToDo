import { EMPTY_DRUPAL_PRESET_PAGE } from '@/types/nodes/drupal-http.types';

import type { DrupalPresetTargets } from '@/types/nodes/drupal-http.types';

/** Pagina agregadora de licitaciones de pruebas. */
export const SANDBOX_LICITACIONES_UUID = '7f1700bf-b54b-4c12-b71a-8a71f1f0ee38';

/** Pagina de verificacion de titulos de pruebas. */
export const SANDBOX_TITULOS_UUID = 'b17d69d8-6998-4883-b8dc-153b55dbd9c5';

/**
 * Paginas de los destinos rapidos como las serviria `GET /api/nodos/drupal/targets`.
 *
 * Solo la importan los `*.spec.ts`. Reproduce el caso que las pruebas de presets
 * necesitan: paginas de pruebas de licitaciones y titulos declaradas, la de
 * cerradas y todas las del portal sin declarar, para que los presets que dejan
 * la pagina al operador sigan pudiendo probarse.
 */
export const DRUPAL_PRESET_TARGETS_FIXTURE: DrupalPresetTargets = {
  SANDBOX: {
    ABRIR_LICITACION: {
      targetNodeUuid: SANDBOX_LICITACIONES_UUID,
      destinationNodeUuid: null,
      nid: 55937,
    },
    CERRAR_LICITACION: {
      targetNodeUuid: SANDBOX_LICITACIONES_UUID,
      destinationNodeUuid: null,
      nid: 55937,
    },
    VERIFICACION_TITULOS: {
      targetNodeUuid: SANDBOX_TITULOS_UUID,
      destinationNodeUuid: null,
      nid: 55938,
    },
    INNODAYS: EMPTY_DRUPAL_PRESET_PAGE,
    INNOBAR: EMPTY_DRUPAL_PRESET_PAGE,
    NOTIWEB: EMPTY_DRUPAL_PRESET_PAGE,
  },
  PRODUCTION: {
    ABRIR_LICITACION: EMPTY_DRUPAL_PRESET_PAGE,
    CERRAR_LICITACION: EMPTY_DRUPAL_PRESET_PAGE,
    VERIFICACION_TITULOS: EMPTY_DRUPAL_PRESET_PAGE,
    INNODAYS: EMPTY_DRUPAL_PRESET_PAGE,
    INNOBAR: EMPTY_DRUPAL_PRESET_PAGE,
    NOTIWEB: EMPTY_DRUPAL_PRESET_PAGE,
  },
};
