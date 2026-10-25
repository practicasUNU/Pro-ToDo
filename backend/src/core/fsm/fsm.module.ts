import { Logger, Module } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';

import { FsmController } from '@core/fsm/controllers/fsm.controller';
import { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import { AiPromptTemplatesModule } from '@modules/ai-prompt-templates/ai-prompt-templates.module';
import { LogsModule } from '@modules/logs/logs.module';
import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import { FsmEngineService } from '@core/fsm/services/fsm-engine.service';
import { FsmExecutionQueryService } from '@core/fsm/services/fsm-execution-query.service';
import { PipelineValidatorService } from '@core/fsm/services/pipeline-validator.service';
import { ExecutionState } from '@core/fsm/types/fsm.enums';
import { HttpCoreModule } from '@core/http/http-core.module';

import type { OnModuleInit } from '@nestjs/common';
import type { Repository } from 'typeorm';

/**
 * Modulo del motor FSM: contratos, validacion, factoria de estrategias y el
 * bucle de ejecucion con su persistencia de checkpoints.
 *
 * `NodeStrategyFactory` se exporta para que los modulos de nodos (PROT-10)
 * registren sus estrategias contra la misma instancia que consume el motor.
 */
@Module({
  // `AiPromptTemplatesModule` aporta `PROMPT_TEXT_RESOLVER`, con el que
  // `PipelineValidatorService` analiza los namespaces que cita un prompt
  // guardado. Es el mismo cruce que ya existe con `LogsModule`, y sigue siendo
  // aciclico: aquel modulo solo importa su propio repositorio.
  imports: [
    TypeOrmModule.forFeature([FsmExecution]),
    LogsModule,
    AiPromptTemplatesModule,
    // `OutboundTargetGuard`, para la guarda SSRF al GUARDAR un destino HTTP.
    HttpCoreModule,
  ],
  controllers: [FsmController],
  providers: [
    PipelineValidatorService,
    NodeStrategyFactory,
    FsmEngineService,
    FsmExecutionQueryService,
  ],
  // Se exporta el servicio de CONSULTA y no el repositorio: asi `@modules`
  // puede leer `ejecuciones_flujo` sin ganar permiso para escribirla, que
  // sigue siendo competencia exclusiva del motor.
  exports: [
    PipelineValidatorService,
    NodeStrategyFactory,
    FsmEngineService,
    FsmExecutionQueryService,
  ],
})
export class FsmModule implements OnModuleInit {
  private readonly logger = new Logger(FsmModule.name);

  constructor(
    @InjectRepository(FsmExecution)
    private readonly executionRepository: Repository<FsmExecution>,
  ) {}

  /**
   * Reconcilia las ejecuciones que quedaron colgadas de un proceso anterior.
   *
   * Una fila EN_PROCESO significa "hay un bucle atendiendo este flujo ahora
   * mismo". Tras un reinicio esa afirmacion es falsa: no queda ningun bucle,
   * pero la fila sigue reservando el mutex `idx_flujo_activo` y el flujo NO
   * podria volver a arrancar nunca. Pasarlas a PAUSADO libera el indice y las
   * deja exactamente donde el protocolo de resiliencia
   * (`architecture-patterns.md` §4) espera encontrarlas para el reintento.
   *
   * El error no se captura a proposito: arrancar el motor sobre un estado que
   * no se ha podido reconciliar es peor que no arrancar.
   */
  public async onModuleInit(): Promise<void> {
    const { affected } = await this.executionRepository.update(
      { currentState: ExecutionState.EN_PROCESO },
      { currentState: ExecutionState.PAUSADO },
    );

    if (affected) {
      this.logger.warn(
        `Reconciliacion de arranque: ${affected} ejecucion(es) EN_PROCESO sin proceso vivo pasan a PAUSADO.`,
      );
    }
  }
}
