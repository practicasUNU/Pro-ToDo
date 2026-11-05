import { Logger } from '@nestjs/common';

import { CrudEventsCoordinator } from '@common/services/crud-events.coordinator';

import type { CrudEventPort } from '@common/services/crud-events.coordinator';
import type { CrudMutationPayload } from '@common/types/crud-events.types';

const PAYLOAD: CrudMutationPayload = {
  entity: 'users',
  action: 'CREATED',
  id: 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  emittedAt: '2026-10-11T00:00:00.000Z',
};

const buildPort = (): CrudEventPort & { emitCrudMutation: jest.Mock } => ({
  emitCrudMutation: jest.fn(),
});

describe('CrudEventsCoordinator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('1.1 deberia repartir la mutacion entre los puertos inscritos', () => {
    // 1. Arrange 📐
    const coordinator = new CrudEventsCoordinator();
    const first = buildPort();
    const second = buildPort();
    coordinator.registerPort(first);
    coordinator.registerPort(second);

    // 2. Act ⚙️
    coordinator.dispatch(PAYLOAD);

    // 3. Assert 🎯
    expect(first.emitCrudMutation).toHaveBeenCalledWith(PAYLOAD);
    expect(second.emitCrudMutation).toHaveBeenCalledWith(PAYLOAD);
  });

  it('1.2 NO deberia emitir hacia un puerto dado de baja', () => {
    // 1. Arrange 📐: se retira con la MISMA referencia con la que se inscribio,
    //    que es lo que permite a Nest recargar en modo --watch sin duplicar.
    const coordinator = new CrudEventsCoordinator();
    const port = buildPort();
    coordinator.registerPort(port);
    coordinator.unregisterPort(port);

    // 2. Act ⚙️
    coordinator.dispatch(PAYLOAD);

    // 3. Assert 🎯
    expect(port.emitCrudMutation).not.toHaveBeenCalled();
  });

  it('1.3 NO deberia duplicar la emision al inscribir dos veces la misma referencia', () => {
    // 1. Arrange 📐: es un `Set`, no una lista.
    const coordinator = new CrudEventsCoordinator();
    const port = buildPort();
    coordinator.registerPort(port);
    coordinator.registerPort(port);

    // 2. Act ⚙️
    coordinator.dispatch(PAYLOAD);

    // 3. Assert 🎯
    expect(port.emitCrudMutation).toHaveBeenCalledTimes(1);
  });

  it('1.4 deberia seguir repartiendo aunque un puerto lance', () => {
    // 1. Arrange 📐: un canal roto no puede dejar sordos a los demas, ni
    //    deshacer una escritura ya confirmada en PostgreSQL.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const coordinator = new CrudEventsCoordinator();
    const broken = buildPort();
    broken.emitCrudMutation.mockImplementation(() => {
      throw new Error('socket caido');
    });
    const healthy = buildPort();
    coordinator.registerPort(broken);
    coordinator.registerPort(healthy);

    // 2. Act ⚙️
    expect(() => coordinator.dispatch(PAYLOAD)).not.toThrow();

    // 3. Assert 🎯
    expect(healthy.emitCrudMutation).toHaveBeenCalledWith(PAYLOAD);
  });

  it('1.5 deberia ser un no-op silencioso sin puertos inscritos', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯: es lo que permite inyectar la
    //    clase real en las pruebas de los servicios en vez de un doble.
    expect(() => new CrudEventsCoordinator().dispatch(PAYLOAD)).not.toThrow();
  });
});
