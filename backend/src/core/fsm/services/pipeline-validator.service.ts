import { BadRequestException, Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  PipelineNodeConfigDto,
  PipelineSchemaDto,
} from '@core/fsm/dto/pipeline-schema.dto';
import { validatePipelineTopology } from '@core/fsm/validators/pipeline-topology.validator';

import type { SchemaIssue } from '@core/fsm/validators/pipeline-topology.validator';
import type { ValidationError, ValidatorOptions } from 'class-validator';

/** Codigo de error del cuerpo de la excepcion; el frontend conmuta sobre el. */
const SCHEMA_ERROR_CODE = 'PIPELINE_SCHEMA_INVALIDO';

/**
 * `forbidNonWhitelisted` convierte cualquier propiedad no declarada en un error
 * en vez de descartarla en silencio: un `nextStepp` mal escrito debe fallar al
 * guardar el flujo, no dejar un puntero perdido que el motor descubra en runtime.
 */
const VALIDATION_OPTIONS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

/** Comprueba que el valor sea un objeto JSON (ni null, ni array, ni primitivo). */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Aplana el arbol de `ValidationError` a rutas con punto.
 *
 * class-validator anida los errores de un DTO hijo en `children`, asi que sin
 * este recorrido `retryPolicy.maxRetries` llegaria al cliente como un simple
 * `retryPolicy` sin indicar que campo concreto falla.
 */
const flattenValidationErrors = (
  errors: ValidationError[],
  parentPath = '',
): SchemaIssue[] =>
  errors.flatMap((error) => {
    const field =
      parentPath === '' ? error.property : `${parentPath}.${error.property}`;
    const constraints = Object.values(error.constraints ?? {});
    const own: SchemaIssue[] =
      constraints.length > 0 ? [{ field, constraints }] : [];

    return [...own, ...flattenValidationErrors(error.children ?? [], field)];
  });

/**
 * Valida el JSON de un pipeline antes de persistirlo en
 * `flujos.configuracion_pipeline`.
 *
 * Es la frontera Poka-Yoke del motor FSM: un esquema que supere este servicio
 * tiene forma, tipos y grafo correctos, de modo que el `FsmEngineService` puede
 * recorrerlo sin comprobaciones defensivas en cada paso.
 */
@Injectable()
export class PipelineValidatorService {
  /**
   * Convierte un JSON arbitrario en un `PipelineSchemaDto` validado.
   *
   * @param rawJson Payload sin tipar, tal y como llega del cliente o de la BD.
   * @returns La instancia validada del esquema.
   * @throws BadRequestException Con la lista exacta de campos invalidos.
   */
  public async validateSchema(rawJson: unknown): Promise<PipelineSchemaDto> {
    if (!isPlainObject(rawJson)) {
      this.rejectWith([
        {
          field: '(root)',
          constraints: ['El esquema del pipeline debe ser un objeto JSON.'],
        },
      ]);
    }

    const schema = plainToInstance(PipelineSchemaDto, rawJson);
    const issues = flattenValidationErrors(
      await validate(schema, VALIDATION_OPTIONS),
    );

    // El mapa solo se recorre si es realmente un objeto: sobre una cadena,
    // Object.entries devolveria un error por cada caracter.
    if (isPlainObject(schema.nodes)) {
      issues.push(...(await this.validateNodes(schema.nodes)));
    }

    // La topologia presupone forma y tipos correctos (ver el TSDoc del validador).
    if (issues.length === 0) {
      issues.push(...validatePipelineTopology(schema));
    }

    if (issues.length > 0) {
      this.rejectWith(issues);
    }

    return schema;
  }

  /**
   * Valida cada nodo por separado y prefija sus errores con `nodes.<clave>.`.
   *
   * class-validator 0.15.1 no itera `Record` con `@ValidateNested({ each: true })`
   * —solo Array, Set y Map—, asi que la iteracion es manual. A cambio se conserva
   * la clave del nodo en la ruta del error, que es justo lo que necesita el wizard
   * del frontend para senalar el paso culpable.
   */
  private async validateNodes(
    nodes: Record<string, unknown>,
  ): Promise<SchemaIssue[]> {
    const issues: SchemaIssue[] = [];

    for (const [key, rawNode] of Object.entries(nodes)) {
      if (!isPlainObject(rawNode)) {
        issues.push({
          field: `nodes.${key}`,
          constraints: ['Cada nodo debe ser un objeto de configuracion.'],
        });
        continue;
      }

      const node = plainToInstance(PipelineNodeConfigDto, rawNode);
      const nodeErrors = await validate(node, VALIDATION_OPTIONS);

      issues.push(...flattenValidationErrors(nodeErrors, `nodes.${key}`));
    }

    return issues;
  }

  /** Lanza la excepcion estructurada. Tipada como `never` para cortar el flujo. */
  private rejectWith(issues: SchemaIssue[]): never {
    throw new BadRequestException({
      statusCode: 400,
      error: SCHEMA_ERROR_CODE,
      message: 'El esquema del pipeline no supera la validacion.',
      issues,
    });
  }
}
