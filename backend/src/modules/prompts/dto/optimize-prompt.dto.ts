import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { PROMPT_TARGET_FORMATS } from '@modules/prompts/prompt-meta.template';

import type { PromptTargetFormat } from '@modules/prompts/prompt-meta.template';

/**
 * Techo del borrador. Generoso para un prompt (que rara vez pasa de unos pocos
 * miles de caracteres) y a la vez un freno al coste: cada caracter viaja al
 * proveedor y se factura.
 */
export const MAX_DRAFT_PROMPT_LENGTH = 20_000;

/** Cuerpo de `POST /api/prompts/optimize`. */
export class OptimizePromptDto {
  @ApiProperty({
    description: 'Borrador de prompt a optimizar',
    maxLength: MAX_DRAFT_PROMPT_LENGTH,
  })
  @IsString({ message: 'draftPrompt debe ser un texto.' })
  @IsNotEmpty({ message: 'draftPrompt no puede estar vacio.' })
  @MaxLength(MAX_DRAFT_PROMPT_LENGTH, {
    message: `draftPrompt no puede superar ${MAX_DRAFT_PROMPT_LENGTH} caracteres.`,
  })
  readonly draftPrompt: string;

  @ApiProperty({ enum: PROMPT_TARGET_FORMATS })
  @IsIn(PROMPT_TARGET_FORMATS, {
    message: `targetFormat debe ser uno de: ${PROMPT_TARGET_FORMATS.join(', ')}.`,
  })
  readonly targetFormat: PromptTargetFormat;

  @ApiPropertyOptional({
    description:
      'Modelo del catalogo (`GET /api/llm/models`). Por defecto, el de texto del entorno',
    example: 'gemini-3.6-flash',
  })
  @IsOptional()
  @IsString({ message: 'model debe ser un texto.' })
  @MaxLength(100, { message: 'model no puede superar 100 caracteres.' })
  readonly model?: string;
}

/** Consumo de la optimizacion, para el chip del modal. */
export class PromptOptimizationTelemetryDto {
  @ApiProperty()
  readonly tokensPrompt: number;

  @ApiProperty()
  readonly tokensCompletion: number;

  @ApiProperty()
  readonly tokensReasoning: number;

  @ApiProperty({ description: 'Coste estimado en USD' })
  readonly estimatedCostUSD: number;

  @ApiProperty({
    description: 'El coste es aproximado (tarifa generica o uso no informado)',
  })
  readonly isEstimated: boolean;

  @ApiProperty({ example: 'GEMINI' })
  readonly provider: string;

  @ApiProperty({ example: 'gemini-3.6-flash' })
  readonly model: string;
}

/** Respuesta de `POST /api/prompts/optimize`. */
export class OptimizePromptResponseDto {
  @ApiProperty({ description: 'Prompt reescrito, listo para aplicar' })
  readonly optimizedPrompt: string;

  @ApiProperty({ type: [String] })
  readonly recommendations: string[];

  @ApiProperty({ type: PromptOptimizationTelemetryDto })
  readonly telemetry: PromptOptimizationTelemetryDto;
}
