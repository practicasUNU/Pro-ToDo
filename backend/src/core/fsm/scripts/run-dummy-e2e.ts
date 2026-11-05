import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import {
  buildDummySchema,
  registerDummyStrategies,
  seedDummyExecution,
} from '@core/fsm/scripts/dummy-pipeline.fixture';
import { FsmEngineService } from '@core/fsm/services/fsm-engine.service';
import { PipelineValidatorService } from '@core/fsm/services/pipeline-validator.service';

import { AppModule } from '../../../app.module';

import type { Repository } from 'typeorm';

/**
 * Runner manual de verificacion del motor FSM contra PostgreSQL real.
 *
 *   npm run test:fsm:manual
 *
 * Arranca el contexto de Nest SIN servidor HTTP (`createApplicationContext`):
 * aqui no hacen falta guards ni pipes, solo el grafo de dependencias y la
 * conexion de TypeORM. Siembra un flujo, ejecuta el pipeline dummy de 3 nodos y
 * vuelve a leer la fila DESDE LA BASE para imprimir lo que realmente quedo
 * escrito, no lo que el motor creia haber escrito.
 *
 * Las filas se conservan a proposito: sirven para inspeccionar el resultado con
 * psql despues de cada corrida.
 */
const logger = new Logger('RunDummyE2E');

const main = async (): Promise<void> => {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const strategyFactory = app.get(NodeStrategyFactory);
    const fsmEngineService = app.get(FsmEngineService);
    const pipelineValidator = app.get(PipelineValidatorService);
    const dataSource = app.get(DataSource);
    const repository = app.get<Repository<FsmExecution>>(
      getRepositoryToken(FsmExecution),
    );

    registerDummyStrategies(strategyFactory);

    const { flowId, executionId } = await seedDummyExecution(
      dataSource,
      repository,
    );
    logger.log(`Flujo sembrado: ${flowId} | ejecucion: ${executionId}`);

    const schema = buildDummySchema(flowId);

    // El esquema dummy usa NodeType reales, asi que puede pasar por el validador
    // de PROT-07: se comprueba de paso que sigue siendo un pipeline legitimo.
    await pipelineValidator.validateSchema(schema);
    logger.log('El esquema dummy supera PipelineValidatorService.');

    await fsmEngineService.executeWorkflow(executionId, schema);

    // Relectura desde PostgreSQL: es la unica prueba real de la persistencia.
    const persisted = await repository.findOne({ where: { executionId } });

    if (persisted === null) {
      throw new Error(`La ejecucion ${executionId} no quedo persistida.`);
    }

    console.log('\n===== CHECKPOINT PERSISTIDO EN ejecuciones_flujo =====');
    console.table([
      {
        id_ejecucion: persisted.executionId,
        estado: persisted.currentState,
        paso_actual: persisted.activeCursor,
        namespaces: Object.keys(persisted.contextPayload).join(', '),
      },
    ]);

    console.log('\n----- contexto_acumulado -----');
    console.log(JSON.stringify(persisted.contextPayload, null, 2));
    console.log('\n----- retry_state -----');
    console.log(JSON.stringify(persisted.retryState, null, 2));
    console.log(
      `\nInspeccion posterior:\n  SELECT * FROM ejecuciones_flujo WHERE id_ejecucion = '${executionId}';\n`,
    );
  } finally {
    // Sin esto el proceso queda colgado del pool de conexiones de TypeORM.
    await app.close();
  }
};

main().catch((error: unknown) => {
  logger.error(
    error instanceof Error ? error.message : 'Error desconocido',
    error instanceof Error ? error.stack : undefined,
  );
  process.exitCode = 1;
});
