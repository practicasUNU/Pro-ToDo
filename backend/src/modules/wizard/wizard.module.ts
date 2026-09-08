import { Module } from '@nestjs/common';

import { WizardController } from './wizard.controller';
import { WizardService } from './wizard.service';

/**
 * Modulo del asistente de creacion de flujos.
 *
 * NO importa `NodesModule` a proposito, aunque reutilice su
 * `ImapTriggerConfigDto` y su `createImapClient`: ambos son un DTO y una funcion
 * pura, no providers, asi que se consumen por importacion directa sin cablear
 * nada. Traerse `NodesModule` arrastraria el sondeo periodico, su repositorio de
 * `flujos` y `WorkflowsModule` detras, para no usar ninguno de los tres.
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
