import { ConfigService } from '@nestjs/config';

import { TemplateRendererService } from '@modules/templates/services/template-renderer.service';

/**
 * Prefijo de assets de las pruebas.
 *
 * Fijo y distinto del de `backend/.env` a proposito: si una asercion pasara por
 * casualidad con el valor de produccion, no se notaria que el servicio esta
 * leyendo la variable equivocada.
 */
export const TEST_ASSETS_BASE_URL = 'https://cdn.test.local/uploads';

/**
 * Instancia el renderer con un `ConfigService` sembrado.
 *
 * Se usa el `ConfigService` REAL con su `internalConfig` en vez de un doble
 * casteado: la clase no tiene dependencias y asi el test comprueba tambien que
 * la clave que el servicio pide (`ASSETS_BASE_URL`) es la que existe de verdad.
 *
 * OJO: `ConfigService.get()` da prioridad a `process.env` sobre el objeto
 * interno. Con la variable exportada en el shell, estas pruebas leerian ese
 * valor; no se exporta en CI ni en el flujo normal de `npm test`.
 *
 * @param assetsBaseUrl Prefijo a inyectar. `null` omite la clave, para
 *        ejercitar el fallback `DEFAULT_ASSETS_BASE_URL`.
 */
export const createTemplateRendererService = (
  assetsBaseUrl: string | null = TEST_ASSETS_BASE_URL,
): TemplateRendererService =>
  new TemplateRendererService(
    new ConfigService(
      assetsBaseUrl === null ? {} : { ASSETS_BASE_URL: assetsBaseUrl },
    ),
  );
