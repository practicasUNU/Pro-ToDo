import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsObject,
  Validate,
  ValidatorConstraint,
} from 'class-validator';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';

import type {
  ValidationArguments,
  ValidatorConstraintInterface,
} from 'class-validator';

/** Tope del contexto simulado: cabe un adjunto de 5 MB en base64 con holgura. */
export const MAX_SANDBOX_CONTEXT_BYTES = 8 * 1024 * 1024;

/** Formato de un namespace (`snake_case`), como `outputNamespace`. */
const NAMESPACE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * El contexto simulado: un mapa `namespace -> objeto`, acotado en tamano.
 *
 * Constraint propio porque `@IsObject` acepta cualquier objeto y el
 * `StatePayloadContext` exige que cada namespace sea a su vez un objeto plano.
 */
@ValidatorConstraint({ name: 'isSandboxContext', async: false })
export class IsSandboxContextConstraint implements ValidatorConstraintInterface {
  public validate(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }

    const entries = Object.entries(value);
    const shapeOk = entries.every(
      ([namespace, data]) =>
        NAMESPACE_PATTERN.test(namespace) &&
        typeof data === 'object' &&
        data !== null &&
        !Array.isArray(data),
    );

    return shapeOk && JSON.stringify(value).length <= MAX_SANDBOX_CONTEXT_BYTES;
  }

  public defaultMessage(args: ValidationArguments): string {
    return `${args.property} debe ser un objeto { namespace: { campo: valor } } con namespaces en snake_case y no superar ${MAX_SANDBOX_CONTEXT_BYTES} bytes.`;
  }
}

/** Peticion de `POST /nodes/sandbox/run`. */
export class RunNodeSandboxDto {
  @ApiProperty({ enum: NodeType, example: NodeType.DESTINO_HTTP_GENERICO })
  @IsEnum(NodeType, { message: 'nodeType debe ser un tipo de nodo valido.' })
  nodeType!: NodeType;

  @ApiProperty({
    description:
      'Params del nodo, los mismos que guardaria el pipeline_schema.',
    example: { targetUrl: 'https://api.ejemplo.org/v1/avisos' },
  })
  @IsObject({ message: 'params debe ser un objeto.' })
  params!: Record<string, unknown>;

  @ApiProperty({
    description:
      'Datos simulados de los pasos anteriores, por namespace (ej. parsed_email).',
    example: { parsed_email: { clean_title: 'Convocatoria 2026' } },
  })
  @Validate(IsSandboxContextConstraint)
  upstreamContext!: Record<string, Record<string, unknown>>;
}
