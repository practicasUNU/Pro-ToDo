import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';

import { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import { PipelineValidatorService } from '@core/fsm/services/pipeline-validator.service';
import { AuditActionType } from '@modules/audit/enums/audit-action.enum';
import { AuditLoggerService } from '@modules/audit/services/audit-logger.service';
import {
  ERR_SANDBOX_NODE_TYPE,
  ERR_SANDBOX_PARAMS,
  SANDBOX_NODE_ID,
  SANDBOX_ROLES_BY_NODE_TYPE,
} from '@modules/nodes/sandbox/node-sandbox.constants';

import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';
import type { RunNodeSandboxDto } from '@modules/nodes/sandbox/dto/run-node-sandbox.dto';
import type { NodeSandboxResultDto } from '@modules/nodes/sandbox/dto/node-sandbox-result.dto';
import type { NodeResult } from '@core/fsm/types/node-strategy.types';

/** Tabla logica de los eventos `PRUEBA_NODO`: el banco no tiene fila propia. */
const SANDBOX_AUDIT_TABLE = 'banco_pruebas';

/** Datos de la peticion que no viajan en el cuerpo. */
export interface NodeSandboxRequestMeta {
  /** IP de origen, para el evento `PRUEBA_NODO` de `audit_eventos`. */
  readonly sourceIp: string | null;
}

/**
 * Ejecucion AISLADA de un nodo desde el banco de pruebas.
 *
 * Corre la estrategia REAL con un `StatePayloadContext` sembrado con los datos
 * simulados que manda el cliente, sin motor, sin checkpoint y sin fila en
 * `ejecuciones_flujo`. Es lo que permite comprobar un prompt o una API destino
 * antes de montar el flujo entero.
 *
 * Tres barreras, por orden:
 * 1. El tipo esta en `SANDBOX_ROLES_BY_NODE_TYPE` (400 si no).
 * 2. El rol del usuario esta entre los permitidos para ESE tipo (403 si no).
 *    Va en el servicio y no en `@Roles` porque depende del cuerpo: el mismo
 *    endpoint admite a un EDITOR para HTTP y lo rechaza para IA.
 * 3. Los `params` superan el DTO del nodo (400 con la ruta del campo).
 *
 * Los efectos son los de produccion, y es deliberado: la IA factura (la
 * telemetria lo imputa al usuario con el origen BANCO_PRUEBAS) y el destino
 * HTTP envia la peticion de verdad, por la misma guarda SSRF. Por eso cada
 * prueba que llega a ejecutarse deja ademas un evento `PRUEBA_NODO` en
 * `audit_eventos` con el usuario, el tipo de nodo y el resultado.
 */
@Injectable()
export class NodeSandboxService {
  private readonly logger = new Logger('NodeSandboxService');

  constructor(
    private readonly strategyFactory: NodeStrategyFactory,
    private readonly pipelineValidator: PipelineValidatorService,
    private readonly auditLogger: AuditLoggerService,
  ) {}

  public async run(
    dto: RunNodeSandboxDto,
    user: AuthenticatedUser,
    meta: NodeSandboxRequestMeta = { sourceIp: null },
  ): Promise<NodeSandboxResultDto> {
    const allowedRoles = SANDBOX_ROLES_BY_NODE_TYPE[dto.nodeType];

    if (allowedRoles === undefined) {
      throw new BadRequestException({
        code: ERR_SANDBOX_NODE_TYPE,
        message: `El nodo ${dto.nodeType} no se puede probar de forma aislada en el banco de pruebas.`,
      });
    }

    if (!allowedRoles.includes(user.role)) {
      throw new ForbiddenException(
        `Tu rol no permite ejecutar ${dto.nodeType} en el banco de pruebas.`,
      );
    }

    const issues = await this.pipelineValidator.validateStandaloneParams(
      dto.nodeType,
      dto.params,
    );

    if (issues.length > 0) {
      throw new BadRequestException({
        code: ERR_SANDBOX_PARAMS,
        message: 'La configuracion del nodo no es valida.',
        issues,
      });
    }

    const context = this.buildContext(dto, user);
    const strategy = this.strategyFactory.getStrategy(dto.nodeType);
    const startedAt = Date.now();

    this.logger.log(
      `Banco de pruebas: ${dto.nodeType} lanzado por ${user.email} (${user.id})`,
    );

    let result: NodeResult;

    try {
      result = await strategy.execute(context, dto.params);
    } catch (error: unknown) {
      // Una estrategia que revienta tambien es una prueba hecha: se audita
      // antes de dejar que la excepcion siga su curso.
      await this.recordAudit(dto, user, meta, {
        success: false,
        errorCode: 'ERR_NODE_CRASHED',
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }

    const durationMs = Date.now() - startedAt;

    await this.recordAudit(dto, user, meta, {
      success: result.success,
      errorCode: result.error?.code ?? null,
      durationMs,
    });

    if (result.success) {
      return { success: true, data: result.data ?? {}, durationMs };
    }

    // Sin `stackTrace` ni `metadata`: el detalle tecnico se queda en el log del
    // servidor, como en una ejecucion real.
    const { error } = result;

    return {
      success: false,
      ...(result.data !== undefined ? { data: result.data } : {}),
      ...(error !== undefined
        ? {
            error: {
              level: error.level,
              code: error.code,
              message: error.message,
              ...(error.description !== undefined
                ? { description: error.description }
                : {}),
              ...(error.missingFields !== undefined
                ? { missingFields: error.missingFields }
                : {}),
            },
          }
        : {}),
      durationMs,
    };
  }

  /**
   * Evento `PRUEBA_NODO`. Sin los `params` ni los datos simulados: pueden
   * llevar contenido real del usuario, y el auditor solo necesita saber quien
   * probo que nodo y como acabo. `AuditLoggerService` nunca lanza.
   */
  private async recordAudit(
    dto: RunNodeSandboxDto,
    user: AuthenticatedUser,
    meta: NodeSandboxRequestMeta,
    outcome: {
      readonly success: boolean;
      readonly errorCode: string | null;
      readonly durationMs: number;
    },
  ): Promise<void> {
    await this.auditLogger.record({
      userId: user.id,
      action: AuditActionType.NODE_SANDBOX_RUN,
      affectedTable: SANDBOX_AUDIT_TABLE,
      recordId: null,
      newData: {
        nodeType: dto.nodeType,
        success: outcome.success,
        errorCode: outcome.errorCode,
        durationMs: outcome.durationMs,
      },
      sourceIp: meta.sourceIp,
    });
  }

  /** Contexto efimero con los namespaces simulados y el ambito de banco. */
  private buildContext(
    dto: RunNodeSandboxDto,
    user: AuthenticatedUser,
  ): StatePayloadContext {
    const executionId = `sandbox-${randomUUID()}`;
    const context = new StatePayloadContext(
      executionId,
      executionId,
      SANDBOX_NODE_ID,
      { userId: user.id },
    );

    for (const [namespace, data] of Object.entries(dto.upstreamContext)) {
      context.setNamespace(namespace, data);
    }

    return context;
  }
}
