import { WorkflowStatusCoordinator } from '@common/services/workflow-status.coordinator';

const FLOW_ID = 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const REASON = 'ERR_LLM_TIMEOUT';

/**
 * Puerto doble.
 *
 * Se declara con miembros `jest.Mock` en vez de `jest.Mocked<WorkflowStatusPort>`
 * porque `expect(port.metodo)` sobre un tipo con metodos de instancia dispara
 * `@typescript-eslint/unbound-method`. Mismo criterio que el spec hermano de
 * `FlowPollingCoordinator`.
 */
interface PortMock {
  pauseFlow: jest.Mock;
}

const buildPort = (): PortMock => ({
  pauseFlow: jest.fn().mockResolvedValue(undefined),
});

interface Harness {
  coordinator: WorkflowStatusCoordinator;
  port: PortMock;
  errorSpy: jest.SpyInstance;
}

/** Coordinador real —no tiene dependencias— con un puerto doble. */
const buildHarness = (): Harness => {
  const coordinator = new WorkflowStatusCoordinator();
  const port = buildPort();

  const errorSpy = jest
    .spyOn(coordinator['logger'], 'error')
    .mockImplementation(() => undefined);

  return { coordinator, port, errorSpy };
};

describe('WorkflowStatusCoordinator (puerto de pausa del flujo, @core -> @modules)', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('1. Delegacion en el puerto registrado', () => {
    it('1.1 deberia delegar la pausa con el flujo y el motivo', async () => {
      // 1. Arrange 📐
      const { coordinator, port } = buildHarness();
      coordinator.register(port);

      // 2. Act ⚙️
      await coordinator.pauseFlow(FLOW_ID, REASON);

      // 3. Assert 🎯
      expect(port.pauseFlow).toHaveBeenCalledWith(FLOW_ID, REASON);
    });

    it('1.2 deberia ESPERAR a que el puerto termine', async () => {
      // 1. Arrange 📐: el llamante emite `flow:paused` justo despues, y el
      //    cliente repinta la fila leyendola. Sin la espera, el evento podria
      //    adelantar a la escritura y la interfaz pintaria "Activo" sobre un
      //    flujo con una ejecucion detenida.
      const { coordinator, port } = buildHarness();
      let resolved = false;

      port.pauseFlow.mockImplementation(async (): Promise<void> => {
        await Promise.resolve();
        resolved = true;
      });
      coordinator.register(port);

      // 2. Act ⚙️
      await coordinator.pauseFlow(FLOW_ID, REASON);

      // 3. Assert 🎯
      expect(resolved).toBe(true);
    });

    it('1.3 deberia alcanzar a todos los puertos inscritos', async () => {
      // 1. Arrange 📐
      const { coordinator, port } = buildHarness();
      const second = buildPort();
      coordinator.register(port);
      coordinator.register(second);

      // 2. Act ⚙️
      await coordinator.pauseFlow(FLOW_ID, REASON);

      // 3. Assert 🎯
      expect(port.pauseFlow).toHaveBeenCalledTimes(1);
      expect(second.pauseFlow).toHaveBeenCalledTimes(1);
    });
  });

  describe('2. Alta y baja', () => {
    it('2.1 NO deberia hacer nada sin puertos inscritos', async () => {
      // 1. Arrange 📐: es el estado de las pruebas unitarias del motor, que
      //    inyectan la clase real precisamente porque asi es un no-op.
      const { coordinator, errorSpy } = buildHarness();

      // 2. Act ⚙️ & 3. Assert 🎯
      await expect(
        coordinator.pauseFlow(FLOW_ID, REASON),
      ).resolves.toBeUndefined();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('2.2 NO deberia duplicar la entrega al registrar dos veces la misma referencia', async () => {
      // 1. Arrange 📐
      const { coordinator, port } = buildHarness();
      coordinator.register(port);
      coordinator.register(port);

      // 2. Act ⚙️
      await coordinator.pauseFlow(FLOW_ID, REASON);

      // 3. Assert 🎯
      expect(port.pauseFlow).toHaveBeenCalledTimes(1);
    });

    it('2.3 deberia dejar de entregar tras la baja', async () => {
      // 1. Arrange 📐: sin esto, una recarga del `--watch` dejaria conviviendo
      //    un servicio muerto con el nuevo.
      const { coordinator, port } = buildHarness();
      coordinator.register(port);
      coordinator.unregister(port);

      // 2. Act ⚙️
      await coordinator.pauseFlow(FLOW_ID, REASON);

      // 3. Assert 🎯
      expect(port.pauseFlow).not.toHaveBeenCalled();
    });
  });

  describe('3. Aislamiento de un puerto roto', () => {
    it('3.1 NO deberia propagar el fallo de un puerto', async () => {
      // 1. Arrange 📐: quien llama es el motor a mitad de una transicion, con
      //    la ejecucion ya persistida como PAUSADO. Propagar convertiria una
      //    pausa reanudable en una excepcion sin checkpoint.
      const { coordinator, port, errorSpy } = buildHarness();
      port.pauseFlow.mockRejectedValue(new Error('PostgreSQL caido'));
      coordinator.register(port);

      // 2. Act ⚙️ & 3. Assert 🎯
      await expect(
        coordinator.pauseFlow(FLOW_ID, REASON),
      ).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('3.2 deberia seguir entregando a los demas puertos', async () => {
      // 1. Arrange 📐: el `try/catch` es POR PUERTO y no alrededor del bucle.
      const { coordinator, port } = buildHarness();
      const healthy = buildPort();
      port.pauseFlow.mockRejectedValue(new Error('PostgreSQL caido'));
      coordinator.register(port);
      coordinator.register(healthy);

      // 2. Act ⚙️
      await coordinator.pauseFlow(FLOW_ID, REASON);

      // 3. Assert 🎯
      expect(healthy.pauseFlow).toHaveBeenCalledWith(FLOW_ID, REASON);
    });

    it('3.3 deberia tolerar que un puerto se de de baja durante su propio despacho', async () => {
      // 1. Arrange 📐: se itera una COPIA del conjunto; mutarlo mientras se
      //    recorre es la clase de fallo que no deja rastro en ningun log.
      const { coordinator, port } = buildHarness();
      port.pauseFlow.mockImplementation(async (): Promise<void> => {
        coordinator.unregister(port);
        await Promise.resolve();
      });
      coordinator.register(port);

      // 2. Act ⚙️ & 3. Assert 🎯
      await expect(
        coordinator.pauseFlow(FLOW_ID, REASON),
      ).resolves.toBeUndefined();
      expect(port.pauseFlow).toHaveBeenCalledTimes(1);
    });
  });
});
