import { Module } from '@nestjs/common';

import { BrowserModule } from '@modules/nodes/browser.module';

import { WizardController } from './wizard.controller';
import { WizardService } from './wizard.service';

/**
 * Modulo del asistente de creacion de flujos.
 *
 * NO importa `NodesModule` a proposito, aunque reutilice su
 * `ImapTriggerConfigDto`, su `createImapClient`, su `ParserEmailConfigDto` y su
 * `buildParsedEmail`: son DTOs y funciones puras, no providers, asi que se
 * consumen por importacion directa sin cablear nada. Traerse `NodesModule`
 * arrastraria el sondeo periodico, su repositorio de `flujos` y
 * `WorkflowsModule` detras, para no usar ninguno de los tres.
 *
 * SI importa `BrowserModule`, y es la unica excepcion: el banco de pruebas del
 * extractor necesita `WebScraperRunner`, que a diferencia de lo anterior SI es
 * un provider —gobierna un proceso de Chromium compartido, que no puede ser una
 * funcion pura—. Ese modulo existe precisamente por esto: es una hoja con el
 * navegador y nada mas, de modo que el asistente lo consume sin heredar el
 * sondeo de buzones. Y es UNA sola declaracion a proposito: el pool cachea el
 * proceso del navegador en un campo, asi que declararlo en los dos modulos
 * abriria dos Chromium.
 *
 * El caso del parser lo ilustra bien: `ParserEmailStrategy` SI es un provider, y
 * cablearla habria obligado ademas a fabricar un `StatePayloadContext` falso
 * solo para poder invocarla. Extraer la composicion a una funcion pura
 * (`parsed-email-payload.util`) evita las dos cosas y deja una sola
 * implementacion compartida con la ejecucion real.
 *
 * `ConfigModule` tampoco se importa: es global (`isGlobal: true`), y de ahi sale
 * el `ConfigService` con el que `WizardService` resuelve la credencial.
 */
@Module({
  imports: [BrowserModule],
  controllers: [WizardController],
  providers: [WizardService],
  exports: [WizardService],
})
export class WizardModule {}
