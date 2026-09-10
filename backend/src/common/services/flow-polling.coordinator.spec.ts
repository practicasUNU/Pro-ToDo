import { FlowPollingCoordinator } from '@common/services/flow-polling.coordinator';

const FLOW_ID = 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

/**
 * Puerto doble.
 *
 * Se declara con miembros `jest.Mock` en vez de `jest.Mocked<FlowPollingPort>`
 * porque `expect(port.metodo)` sobre un tipo con metodos de instancia dispara
 * `@typescript-eslint/unbound-method`.
 */
interface PortMock {
  stopPollingForFlow: jest.Mock;
  refreshPolling: jest.Mock;
}

interface Harness {
  coordinator: FlowPollingCoordinator;
  port: PortMock;
  errorSpy: jest.SpyInstance;
}

/** Coordinador real —no tiene dependencias— con un puerto doble. */
const buildHarness = (): Harness => {
  const coordinator = new FlowPollingCoordinator();
  const port: PortMock = {
    stopPollingForFlow: jest.fn(),
    refreshPolling: jest.fn().mockResolvedValue(undefined),
  };

  const errorSpy = jest
    .spyOn(coordinator['logger'], 'error')
    .mockImplementation(() => undefined);

  return { coordinator, port, errorSpy };
};

describe('FlowPollingCoordinator (puerto de sondeo, rompe el ciclo de modulos)', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('1. Delegacion en el puerto registrado', () => {
    it('1.1 deberia delegar la parada de un flujo', () => {
      // 1. Arrange
      const { coordinator, port } = buildHarness();
      coordinator.register(port);

      // 2. Act
      coordinator.stopPollingForFlow(FLOW_ID);

      // 3. Assert
      expect(port.stopPollingForFlow).toHaveBeenCalledWith(FLOW_ID);
    });

    it('1.2 deberia delegar la recarga del sondeo', async () => {
      // 1. Arrange
      const { coordinator, port } = buildHarness();
      coordinator.register(port);

      // 2. Act
      await coordinator.refreshPolling();

      // 3. Assert
      expect(port.refreshPolling).toHaveBeenCalledTimes(1);
    });

    it('1.3 deberia sustituir el puerto en un segundo registro', () => {
      // 1. Arrange: simula la recarga del `--watch`, que monta otra instancia.
      const { coordinator, port } = buildHarness();
      const replacement: PortMock = {
        stopPollingForFlow: jest.fn(),
        refreshPolling: jest.fn().mockResolvedValue(undefined),
      };
      coordinator.register(port);
      coordinator.register(replacement);

      // 2. Act
      coordinator.stopPollingForFlow(FLOW_ID);

      // 3. Assert
      expect(replacement.stopPollingForFlow).toHaveBeenCalledWith(FLOW_ID);
      expect(port.stopPollingForFlow).not.toHaveBeenCalled();
    });
  });

  describe('2. Sin implementador registrado', () => {
    it('2.1 no deberia fallar al parar un flujo', () => {
      // 1. Arrange: es el estado real con IMAP_POLLING_ENABLED != "true".
      const { coordinator } = buildHarness();

      // 2. Act + 3. Assert
      expect(() => coordinator.stopPollingForFlow(FLOW_ID)).not.toThrow();
    });

    it('2.2 no deberia fallar al recargar', async () => {
      // 1. Arrange
      const { coordinator } = buildHarness();

      // 2. Act + 3. Assert
      await expect(coordinator.refreshPolling()).resolves.toBeUndefined();
    });

    it('2.3 deberia volver a ser un no-op tras dar de baja el puerto', () => {
      // 1. Arrange
      const { coordinator, port } = buildHarness();
      coordinator.register(port);
      coordinator.unregister();

      // 2. Act
      coordinator.stopPollingForFlow(FLOW_ID);

      // 3. Assert
      expect(port.stopPollingForFlow).not.toHaveBeenCalled();
    });
  });

  describe('3. Aislamiento de fallos del puerto', () => {
    it('3.1 no deberia propagar una excepcion de la parada', () => {
      // 1. Arrange: quien llama ya persistio la desactivacion; un fallo de
      //    limpieza no puede convertirla en un 500.
      const { coordinator, port, errorSpy } = buildHarness();
      port.stopPollingForFlow.mockImplementation(() => {
        throw new Error('SchedulerRegistry roto');
      });
      coordinator.register(port);

      // 2. Act + 3. Assert
      expect(() => coordinator.stopPollingForFlow(FLOW_ID)).not.toThrow();
      expect(errorSpy).toHaveBeenCalled();
    });

    it('3.2 no deberia propagar el rechazo de la recarga', async () => {
      // 1. Arrange
      const { coordinator, port, errorSpy } = buildHarness();
      port.refreshPolling.mockRejectedValue(
        new Error('PostgreSQL no responde'),
      );
      coordinator.register(port);

      // 2. Act + 3. Assert
      await expect(coordinator.refreshPolling()).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    });
  });
});
