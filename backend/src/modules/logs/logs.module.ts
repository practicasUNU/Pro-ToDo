import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AlertaError } from '@modules/logs/entities/alerta-error.entity';
import { LogNodo } from '@modules/logs/entities/log-nodo.entity';
import { HybridLoggerService } from '@modules/logs/services/hybrid-logger.service';

/**
 * Trazabilidad de la ejecucion: archivo rotado en disco y filas en `logs_nodo`.
 *
 * El servicio vivia en `CommonModule`, que es `@Global()`, y se movio aqui al
 * ganar un repositorio propio: una entidad de dominio en la capa comun obligaria
 * a `CommonModule` a declarar el `forFeature` de una tabla que solo usa este
 * servicio, y la capa comun dejaria de ser transversal para ser tambien
 * relacional.
 *
 * El precio es que ya no llega solo a todas partes: quien lo necesite importa
 * este modulo. Hoy solo lo hace `FsmModule`, y que sea explicito es preferible a
 * que aparezca por arte de magia.
 *
 * `AlertaError` viaja junto a `LogNodo` y no en un modulo propio porque el mismo
 * servicio escribe las dos en la misma llamada: separarlas obligaria a exponer
 * un repositorio de una tabla a traves de la frontera de otro modulo para
 * mantener una sola transaccion logica.
 */
@Module({
  imports: [TypeOrmModule.forFeature([LogNodo, AlertaError])],
  providers: [HybridLoggerService],
  exports: [HybridLoggerService],
})
export class LogsModule {}
