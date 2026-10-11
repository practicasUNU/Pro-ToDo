import { ExecutionEventsCoordinator } from '@common/services/execution-events.coordinator';

import type {
  FlowPausedEvent,
  FlowResumedEvent,
  NodeErrorEvent,
} from '@common/types/execution-events.types';

const EXECUTION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const FLOW_ID = 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const EMITTED_AT = '2026-10-10T08:00:00.000Z';

const PAUSED: FlowPausedEvent = {
  executionId: EXECUTION_ID,
  flowId: FLOW_ID,
  emittedAt: EMITTED_AT,
  activeCursor: 'nodo_ia',
  severity: 'GRAVE',
  errorMessage: 'El proveedor devolvio 503.',
  logFilePath: '/logs/execution-2026-10-10.log',
};

const RESUMED: FlowResumedEvent = {
  executionId: EXECUTION_ID,
  flowId: FLOW_ID,
  emittedAt: EMITTED_AT,
  activeCursor: 'nodo_ia',
  resumedBy: 'usuario-1',
};

const NODE_ERROR: NodeErrorEvent = {
  executionId: EXECUTION_ID,
  flowId: FLOW_ID,
  emittedAt: EMITTED_AT,
  nodeId: 'nodo_ia',
  severity: 'LEVE',
  errorCode: 'ERR_LLM_TIMEOUT',
  errorMessage: 'Tiempo agotado.',
  logFilePath: null,
  attempt: 2,
};

/**
 * Puerto doble.
 *
 * Miembros `jest.Mock` y no `jest.Mocked<ExecutionEventPort>` por el mismo
 * motivo que en `flow-polling.coordinator.spec.ts`: aseverar sobre un metodo de
 * instancia dispara `@typescript-eslint/unbound-method`.
 */
interface PortMock {
  emitFlowPaused: jest.Mock;
  emitFlowResumed: jest.Mock;
  emitNodeError: jest.Mock;
}

const buildPort = (): PortMock => ({
  emitFlowPaused: jest.fn(),
  emitFlowResumed: jest.fn(),
  emitNodeError: jest.fn(),
});

interface Harness {
  coordinator: ExecutionEventsCoordinator;
  port: PortMock;
  errorSpy: jest.SpyInstance;
}

/** Coordinador real —no tiene dependencias— con un puerto doble. */
const buildHarness = (): Harness => {
  const coordinator = new ExecutionEventsCoordinator();
  const port = buildPort();

  const errorSpy = jest
    .spyOn(coordinator['logger'], 'error')
    .mockImplementation(() => undefined);

  return { coordinator, port, errorSpy };
};

describe('ExecutionEventsCoordinator (puerto de eventos del motor FSM)', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('1. Reparto a los canales inscritos', () => {
    it('1.1 deberia entregar la pausa al puerto registrado', () => {
      // 1. Arrange
      const { coordinator, port } = buildHarness();
      coordinator.register(port);

      // 2. Act
      coordinator.emitFlowPaused(PAUSED);

      // 3. Assert
      expect(port.emitFlowPaused).toHaveBeenCalledWith(PAUSED);
    });

    it('1.2 deberia entregar la reanudacion al puerto registrado', () => {
      // 1. Arrange
      const { coordinator, port } = buildHarness();
      coordinator.register(port);

      // 2. Act
      coordinator.emitFlowResumed(RESUMED);

      // 3. Assert
      expect(port.emitFlowResumed).toHaveBeenCalledWith(RESUMED);
    });

    it('1.3 deberia entregar el fallo de nodo al puerto registrado', () => {
      // 1. Arrange
      const { coordinator, port } = buildHarness();
      coordinator.register(port);

      // 2. Act
      coordinator.emitNodeError(NODE_ERROR);

      // 3. Assert
      expect(port.emitNodeError).toHaveBeenCalledWith(NODE_ERROR);
    });

    it('1.4 deberia entregar a TODOS los canales, no solo al ultimo', () => {
      // 1. Arrange: la version de puntero unico dejaba al primero sin recibir
      //    nada, en silencio y segun el orden de arranque de los modulos.
      const { coordinator, port } = buildHarness();
      const second = buildPort();
      coordinator.register(port);
      coordinator.register(second);

      // 2. Act
      coordinator.emitFlowPaused(PAUSED);

      // 3. Assert
      expect(port.emitFlowPaused).toHaveBeenCalledTimes(1);
      expect(second.emitFlowPaused).toHaveBeenCalledTimes(1);
    });

    it('1.5 NO deberia duplicar el envio al registrar dos veces la misma referencia', () => {
      // 1. Arrange
      const { coordinator, port } = buildHarness();
      coordinator.register(port);
      coordinator.register(port);

      // 2. Act
      coordinator.emitNodeError(NODE_ERROR);

      // 3. Assert
      expect(port.emitNodeError).toHaveBeenCalledTimes(1);
    });
  });

  describe('2. Blindaje del bucle de la FSM', () => {
    // Es la razon de ser de esta capa: quien llama es el motor a mitad de una
    // transicion, y una notificacion fallida no puede volverse una ejecucion
    // fallida.
    it('2.1 NO deberia propagar la excepcion de un canal roto', () => {
      // 1. Arrange
      const { coordinator, port, errorSpy } = buildHarness();
      port.emitFlowPaused.mockImplementation(() => {
        throw new Error('socket cerrado');
      });
      coordinator.register(port);

      // 2. Act & 3. Assert
      expect(() => coordinator.emitFlowPaused(PAUSED)).not.toThrow();
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('2.2 deberia seguir entregando al resto cuando uno lanza', () => {
      // 1. Arrange: el try/catch es POR PUERTO, no alrededor del recorrido.
      const { coordinator, port } = buildHarness();
      const healthy = buildPort();
      port.emitFlowResumed.mockImplementation(() => {
        throw new Error('socket cerrado');
      });
      coordinator.register(port);
      coordinator.register(healthy);

      // 2. Act
      coordinator.emitFlowResumed(RESUMED);

      // 3. Assert
      expect(healthy.emitFlowResumed).toHaveBeenCalledWith(RESUMED);
    });

    it('2.3 deberia tolerar que un canal se de de baja durante su propio despacho', () => {
      // 1. Arrange: pasa en cada recarga del `--watch`. Mutar el `Set` mientras
      //    se recorre es el fallo que no deja rastro en ningun log.
      const { coordinator, port } = buildHarness();
      const second = buildPort();
      port.emitNodeError.mockImplementation(() => {
        coordinator.unregister(port);
      });
      coordinator.register(port);
      coordinator.register(second);

      // 2. Act & 3. Assert
      expect(() => coordinator.emitNodeError(NODE_ERROR)).not.toThrow();
      expect(second.emitNodeError).toHaveBeenCalledTimes(1);
    });
  });

  describe('3. Baja de canales', () => {
    it('3.1 deberia dejar de entregar tras unregister', () => {
      // 1. Arrange
      const { coordinator, port } = buildHarness();
      coordinator.register(port);
      coordinator.unregister(port);

      // 2. Act
      coordinator.emitFlowPaused(PAUSED);

      // 3. Assert
      expect(port.emitFlowPaused).not.toHaveBeenCalled();
    });

    // Sin canales no es un modo degradado: en las pruebas del motor el
    // coordinador se queda vacio a proposito.
    it('3.2 NO deberia lanzar sin ningun canal inscrito', () => {
      // 1. Arrange
      const { coordinator } = buildHarness();

      // 2. Act & 3. Assert
      expect(() => coordinator.emitNodeError(NODE_ERROR)).not.toThrow();
      expect(() => coordinator.emitFlowResumed(RESUMED)).not.toThrow();
    });
  });
});
