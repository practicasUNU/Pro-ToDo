import { BadRequestException } from '@nestjs/common';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { UserRole } from '@modules/users/enums/user-role.enum';

import { SANDBOX_NODE_ID } from './node-sandbox.constants';
import { NodeSandboxService } from './node-sandbox.service';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import type { PipelineValidatorService } from '@core/fsm/services/pipeline-validator.service';
import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';
import type { RunNodeSandboxDto } from './dto/run-node-sandbox.dto';

const ADMIN: AuthenticatedUser = {
  id: '3f1c2b64-8a5e-4c2f-9d3a-7b6e5f4c1a20',
  email: 'admin@unuware.com',
  role: UserRole.ADMIN,
};

const buildHarness = (
  issues: unknown[] = [],
): {
  service: NodeSandboxService;
  execute: jest.Mock;
  validateStandaloneParams: jest.Mock;
} => {
  const execute = jest.fn().mockResolvedValue({ success: true, data: {} });
  const validateStandaloneParams = jest.fn().mockResolvedValue(issues);

  return {
    service: new NodeSandboxService(
      { getStrategy: () => ({ execute }) } as unknown as NodeStrategyFactory,
      { validateStandaloneParams } as unknown as PipelineValidatorService,
    ),
    execute,
    validateStandaloneParams,
  };
};

const DTO: RunNodeSandboxDto = {
  nodeType: NodeType.PROCESADOR_IA,
  params: { promptText: 'Resume {{parsed_email.clean_body}}' },
  upstreamContext: { parsed_email: { clean_body: 'Texto del correo' } },
};

describe('NodeSandboxService', () => {
  it('1.1 deberia sembrar el contexto simulado y marcarlo como banco de pruebas', async () => {
    // 1. Arrange 📐
    const { service, execute } = buildHarness();

    // 2. Act ⚙️
    await service.run(DTO, ADMIN);

    // 3. Assert 🎯: el ambito lleva al usuario, que es a quien se imputa el
    //    gasto de la inferencia (origen BANCO_PRUEBAS).
    const [context, params] = execute.mock.calls[0] as [
      StatePayloadContext,
      Record<string, unknown>,
    ];

    expect(params).toEqual(DTO.params);
    expect(context.getNamespace('parsed_email')).toEqual({
      clean_body: 'Texto del correo',
    });
    expect(context.getCursor()).toBe(SANDBOX_NODE_ID);
    expect(context.getSandboxScope()).toEqual({ userId: ADMIN.id });
    expect(context.getExecutionId()).toMatch(/^sandbox-/);
  });

  it('1.2 deberia rechazar params invalidos sin ejecutar la estrategia', async () => {
    // 1. Arrange 📐
    const { service, execute } = buildHarness([
      { field: 'params.promptText', constraints: ['obligatorio'] },
    ]);

    // 2. Act ⚙️ + 3. Assert 🎯
    await expect(service.run(DTO, ADMIN)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('1.3 deberia devolver el fallo del nodo SIN la traza de pila', async () => {
    // 1. Arrange 📐: un 503 del proveedor, con su traza interna.
    const { service, execute } = buildHarness();
    execute.mockResolvedValue({
      success: false,
      error: {
        level: 'GRAVE',
        code: 'ERR_LLM_PROVIDER',
        message: 'El proveedor respondio 503',
        stackTrace: 'Error: 503\n    at /srv/app/...',
        metadata: { exhausted: true },
      },
    });

    // 2. Act ⚙️
    const result = await service.run(DTO, ADMIN);

    // 3. Assert 🎯: es un 200 con `success: false`, y la traza no sale.
    expect(result.success).toBe(false);
    expect(result.error).toEqual({
      level: 'GRAVE',
      code: 'ERR_LLM_PROVIDER',
      message: 'El proveedor respondio 503',
    });
    expect(JSON.stringify(result)).not.toContain('/srv/app');
  });

  it('1.4 deberia aislar cada prueba en su propio contexto', async () => {
    // 1. Arrange 📐: dos pruebas simultaneas no comparten namespaces.
    const { service, execute } = buildHarness();

    // 2. Act ⚙️
    await Promise.all([
      service.run(DTO, ADMIN),
      service.run(
        { ...DTO, upstreamContext: { parsed_email: { clean_body: 'Otro' } } },
        ADMIN,
      ),
    ]);

    // 3. Assert 🎯
    const [first, second] = execute.mock.calls.map(
      ([context]) => context as StatePayloadContext,
    );

    expect(first?.getExecutionId()).not.toBe(second?.getExecutionId());
    expect(second?.getNamespace('parsed_email')).toEqual({
      clean_body: 'Otro',
    });
  });
});
