import type {
  RecordTelemetryDto,
  TokenUsageMetrics,
} from '@modules/telemetry/dto/record-telemetry.dto';
import type { TelemetryService } from '@modules/telemetry/telemetry.service';

/** Tarifas fijas del doble, en USD por millon de tokens. */
export const MOCK_PROMPT_RATE_USD = 2;
export const MOCK_COMPLETION_RATE_USD = 10;
export const MOCK_REASONING_RATE_USD = 10;

/** Doble tipado de `TelemetryService`, acotado a lo que llaman los nodos. */
export type TelemetryServiceMock = jest.Mocked<
  Pick<TelemetryService, 'recordTokenUsage' | 'computeUsage'>
>;

/** Mismo calculo que el servicio real, con tarifas fijas y sin base de datos. */
const computeMockMetrics = (dto: RecordTelemetryDto): TokenUsageMetrics => ({
  promptTokens: dto.promptTokens,
  completionTokens: dto.completionTokens,
  reasoningTokens: dto.reasoningTokens,
  totalTokens: dto.promptTokens + dto.completionTokens + dto.reasoningTokens,
  promptRateUsd: MOCK_PROMPT_RATE_USD,
  completionRateUsd: MOCK_COMPLETION_RATE_USD,
  reasoningRateUsd: MOCK_REASONING_RATE_USD,
  estimatedCostUsd:
    (dto.promptTokens * MOCK_PROMPT_RATE_USD +
      dto.completionTokens * MOCK_COMPLETION_RATE_USD +
      dto.reasoningTokens * MOCK_REASONING_RATE_USD) /
    1_000_000,
  isEstimated: !dto.usageReported,
});

/**
 * Construye un `TelemetryService` doblado que registra "bien" por defecto.
 *
 * Las pruebas de los nodos de IA no deben tocar PostgreSQL: lo que examinan es
 * que el nodo LLAME al registro con los datos correctos y que reaccione a su
 * fallo, no el INSERT, que ya cubre `telemetry.service.spec.ts`.
 */
export const createMockTelemetryService = (): TelemetryServiceMock => ({
  recordTokenUsage: jest
    .fn<Promise<TokenUsageMetrics>, [RecordTelemetryDto]>()
    .mockImplementation((dto) => Promise.resolve(computeMockMetrics(dto))),
  computeUsage: jest
    .fn<Promise<TokenUsageMetrics>, [RecordTelemetryDto]>()
    .mockImplementation((dto) => Promise.resolve(computeMockMetrics(dto))),
});
