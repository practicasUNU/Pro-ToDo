import { Module } from '@nestjs/common';

import { BrowserPoolService } from './services/browser-pool.service';
import { WebScraperRunner } from './services/web-scraper.runner';

/**
 * Modulo HOJA del navegador compartido.
 *
 * Existe para que `WizardModule` pueda consumir la navegacion sin importar
 * `NodesModule`, cuyo propio TSDoc ya explica por que eso seria un error:
 * arrastraria `ImapPollingService`, `CronSchedulingService`, el repositorio de
 * `flujos` y `WorkflowsModule` detras, para no usar ninguno de los cuatro. El
 * asistente acabaria sondeando buzones por el mero hecho de exponer un banco de
 * pruebas.
 *
 * UNA SOLA DECLARACION, y esto es lo critico: `BrowserPoolService` cachea un
 * proceso de Chromium en un campo propio, asi que declararlo en dos modulos
 * daria dos instancias y, con ellas, dos navegadores de ~200 MB. Justo la fuga
 * que ese servicio existe para evitar. Por eso el provider vive aqui y los dos
 * consumidores importan este modulo en vez de declararlo cada uno.
 *
 * Sin `imports`: `ConfigModule` es global y es lo unico que el pool necesita. Al
 * ser hoja no puede cerrar ningun ciclo de dependencias.
 */
@Module({
  providers: [BrowserPoolService, WebScraperRunner],
  exports: [BrowserPoolService, WebScraperRunner],
})
export class BrowserModule {}
