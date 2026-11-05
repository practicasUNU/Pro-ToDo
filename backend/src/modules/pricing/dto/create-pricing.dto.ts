import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { TrimmedString } from '@common/decorators/trimmed-string.decorator';
import { ANY_MODEL } from '@modules/telemetry/entities/precio-modelo-ia.entity';
import { LlmProvider } from '@modules/nodes/strategies/interfaces/llm-provider.interface';

/**
 * Proveedores que facturan. `MOCK` queda fuera: es el doble de pruebas del
 * motor y una tarifa suya solo podria ensuciar los informes de coste.
 */
export const PRICING_PROVIDERS = [
  LlmProvider.GEMINI,
  LlmProvider.ANTHROPIC,
  LlmProvider.OPENAI,
] as const;
export type PricingProvider = (typeof PRICING_PROVIDERS)[number];

/** Techo de `NUMERIC(12, 6)`: seis enteros y seis decimales. */
export const MAX_RATE_USD_PER_MTOK = 999_999.999_999;

/** Identificador de modelo: el comodin `*` o un id sin espacios ni comillas. */
export const MODEL_ID_PATTERN = /^(\*|[A-Za-z0-9][A-Za-z0-9._:-]*)$/;

const RATE_OPTIONS = {
  allowNaN: false,
  allowInfinity: false,
  maxDecimalPlaces: 6,
} as const;

/**
 * Alta de una tarifa VIGENTE para el par (proveedor, modelo).
 *
 * Es a la vez el "crear" y el "modificar" del CRUD: modificar una tarifa es
 * registrar la siguiente, y el servicio pasa la anterior a historico en la
 * misma transaccion. Por eso no hay DTO de actualizacion ni de baja.
 *
 * SIN `validFrom`: la vigencia la fija el servidor en el instante del alta.
 * Una fecha futura dejaria un hueco —la anterior ya desactivada y la nueva
 * todavia sin entrar en vigor— en el que `TelemetryService.resolvePricing` no
 * encontraria ninguna tarifa y marcaria el coste como estimado.
 *
 * Las tarifas NO llevan `@Type(() => Number)`: un cuerpo JSON ya trae numeros,
 * y convertir `"1e3"` o `"0x10"` en silencio seria aceptar justo lo que el
 * campo numerico del frontend bloquea.
 */
export class CreatePricingDto {
  @ApiProperty({ enum: PRICING_PROVIDERS, example: LlmProvider.GEMINI })
  @IsIn(PRICING_PROVIDERS, {
    message: `aiProvider debe ser uno de: ${PRICING_PROVIDERS.join(', ')}.`,
  })
  readonly aiProvider: PricingProvider;

  @ApiProperty({
    example: 'gemini-1.5-pro',
    description: `Id exacto del modelo, o \`${ANY_MODEL}\` para la tarifa generica del proveedor`,
    maxLength: 100,
  })
  @TrimmedString()
  @IsString({ message: 'aiModel debe ser texto.' })
  @IsNotEmpty({ message: 'aiModel es obligatorio.' })
  @MaxLength(100, { message: 'aiModel no puede superar 100 caracteres.' })
  @Matches(MODEL_ID_PATTERN, {
    message:
      'aiModel solo admite letras, numeros, ".", "_", ":" y "-", o el comodin "*".',
  })
  readonly aiModel: string;

  @ApiProperty({
    example: 1.25,
    description: 'USD por millon de tokens de entrada',
  })
  @IsNumber(RATE_OPTIONS, {
    message: 'promptRateUsdPerMTok debe ser un numero con hasta 6 decimales.',
  })
  @Min(0, { message: 'promptRateUsdPerMTok no puede ser negativa.' })
  @Max(MAX_RATE_USD_PER_MTOK, {
    message: 'promptRateUsdPerMTok excede el maximo admitido.',
  })
  readonly promptRateUsdPerMTok: number;

  @ApiProperty({
    example: 5,
    description: 'USD por millon de tokens de salida',
  })
  @IsNumber(RATE_OPTIONS, {
    message:
      'completionRateUsdPerMTok debe ser un numero con hasta 6 decimales.',
  })
  @Min(0, { message: 'completionRateUsdPerMTok no puede ser negativa.' })
  @Max(MAX_RATE_USD_PER_MTOK, {
    message: 'completionRateUsdPerMTok excede el maximo admitido.',
  })
  readonly completionRateUsdPerMTok: number;

  @ApiProperty({
    example: 5,
    description:
      'USD por millon de tokens de razonamiento (solo Gemini lo factura aparte)',
  })
  @IsNumber(RATE_OPTIONS, {
    message:
      'reasoningRateUsdPerMTok debe ser un numero con hasta 6 decimales.',
  })
  @Min(0, { message: 'reasoningRateUsdPerMTok no puede ser negativa.' })
  @Max(MAX_RATE_USD_PER_MTOK, {
    message: 'reasoningRateUsdPerMTok excede el maximo admitido.',
  })
  readonly reasoningRateUsdPerMTok: number;
}
