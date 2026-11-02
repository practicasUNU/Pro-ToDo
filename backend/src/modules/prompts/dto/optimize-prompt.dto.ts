import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { TrimmedString } from '@common/decorators/trimmed-string.decorator';
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
  @TrimmedString()
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
  @TrimmedString()
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

/** Variables del prompt optimizado, separadas por necesidad. */
export class RecommendedVariablesDto {
  @ApiProperty({
    type: [String],
    description:
      'Rutas `ns.campo` marcadas como {{*ns.campo}}: si faltan, el flujo se pausa',
    example: ['parsed_email.clean_body'],
  })
  readonly mandatory: string[];

  @ApiProperty({
    type: [String],
    description:
      'Rutas `ns.campo` opcionales ({{ns.campo}}): si faltan, texto vacio',
    example: ['scraped_web.published_at'],
  })
  readonly optional: string[];
}

/** Respuesta de `POST /api/prompts/optimize`. */
export class OptimizePromptResponseDto {
  @ApiProperty({ description: 'Prompt reescrito, listo para aplicar' })
  readonly optimizedPrompt: string;

  @ApiProperty({
    type: RecommendedVariablesDto,
    description: 'Variables del prompt optimizado, obligatorias y opcionales',
  })
  readonly recommendedVariables: RecommendedVariablesDto;

  @ApiProperty({
    description:
      'Diagnostico del borrador y justificacion de las variables obligatorias',
  })
  readonly rationale: string;

  @ApiProperty({ type: [String] })
  readonly recommendations: string[];

  @ApiProperty({ type: PromptOptimizationTelemetryDto })
  readonly telemetry: PromptOptimizationTelemetryDto;
}

/** Alias con el nombre que usa la especificacion funcional. */
export type OptimizedPromptResponseDto = OptimizePromptResponseDto;
