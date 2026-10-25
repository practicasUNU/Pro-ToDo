import { TelemetryOperationOrigin } from '@modules/telemetry/enums/telemetry-origin.enum';
import { describeTelemetrySource } from '@modules/telemetry/reports/telemetry-source.util';

describe('describeTelemetrySource', () => {
  it('1.1 deberia mostrar el flujo en una inferencia de ejecucion', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const source = describeTelemetrySource({
      operationOrigin: TelemetryOperationOrigin.FLOW_EXECUTION,
      flowName: 'Notiweb',
      flowId: 'flow-1',
    });

    // 3. Assert 🎯
    expect(source).toBe('Notiweb');
  });

  it.each([
    [TelemetryOperationOrigin.PROMPT_OPTIMIZATION, 'Optimización de prompt'],
    [TelemetryOperationOrigin.NODE_SANDBOX, 'Banco de pruebas'],
  ])(
    '1.2 deberia mostrar el origen cuando no hay flujo (%s)',
    (operationOrigin, label) => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const source = describeTelemetrySource({
        operationOrigin,
        flowName: null,
        flowId: null,
      });

      // 3. Assert 🎯
      expect(source).toBe(label);
    },
  );
});
