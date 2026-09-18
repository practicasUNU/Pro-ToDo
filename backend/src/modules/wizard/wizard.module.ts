import { Module } from '@nestjs/common';

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
  controllers: [WizardController],
  providers: [WizardService],
  exports: [WizardService],
})
export class WizardModule {}
