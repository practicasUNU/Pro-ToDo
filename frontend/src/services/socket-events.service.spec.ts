import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// El socket se dobla entero: estas pruebas verifican el CONTRATO de acuse del
// servicio, no el transporte.
vi.mock('@services/socket.client', () => ({
  getSocket: vi.fn(),
}));

import { ACK_TIMEOUT, joinFlowRoom, leaveFlowRoom } from '@services/socket-events.service';
import { getSocket } from '@services/socket.client';

import type { RoomAck } from '@/types/execution';

/**
 * Doble del socket con la cadena `timeout().emitWithAck()`.
 *
 * `emitWithAck` RECHAZA al vencer el plazo —es asi como Socket.io senala el
 * acuse que no llego—, de modo que el doble reproduce ese rechazo en lugar de
 * devolver un valor.
 */
const buildSocket = (
  behaviour: { ack: RoomAck } | { rejects: true },
): { emitWithAck: ReturnType<typeof vi.fn> } => {
  const emitWithAck = vi.fn(() =>
    'rejects' in behaviour
      ? Promise.reject(new Error('operation has timed out'))
      : Promise.resolve(behaviour.ack),
  );

  vi.mocked(getSocket).mockReturnValue({
    timeout: () => ({ emitWithAck }),
  } as unknown as ReturnType<typeof getSocket>);

  return { emitWithAck };
};

describe('socket-events.service · acuse de las peticiones de sala', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1.1 deberia propagar el acuse afirmativo del gateway', async () => {
    // 1. Arrange 📐
    const { emitWithAck } = buildSocket({ ack: { ok: true } });

    // 2. Act ⚙️
    const ack = await joinFlowRoom('b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f');

    // 3. Assert 🎯
    expect(ack).toEqual({ ok: true });
    expect(emitWithAck).toHaveBeenCalledWith('flow:subscribe', {
      flowId: 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
    });
  });

  it('1.2 deberia propagar el rechazo razonado del gateway', async () => {
    // 1. Arrange 📐: un flujo inexistente se deniega con FORBIDDEN_ROOM.
    buildSocket({ ack: { ok: false, reason: 'FORBIDDEN_ROOM' } });

    // 2. Act ⚙️
    const ack = await joinFlowRoom('b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f');

    // 3. Assert 🎯: el motivo no se pierde ni se confunde con un vencimiento.
    expect(ack).toEqual({ ok: false, reason: 'FORBIDDEN_ROOM' });
  });

  it('1.3 deberia resolver ACK_TIMEOUT cuando el acuse no llega', async () => {
    // 1. Arrange 📐: con el socket caido, Socket.io encola el emit. Antes del
    //    tope la promesa quedaba pendiente PARA SIEMPRE y el fallo de
    //    transporte se volvia silencio absoluto.
    buildSocket({ rejects: true });

    // 2. Act ⚙️
    const ack = await joinFlowRoom('b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f');

    // 3. Assert 🎯
    expect(ack).toEqual({ ok: false, reason: ACK_TIMEOUT });
  });

  it('1.4 deberia aplicar el mismo tope al abandonar la sala', async () => {
    // 1. Arrange 📐
    buildSocket({ rejects: true });

    // 2. Act ⚙️
    const ack = await leaveFlowRoom('b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f');

    // 3. Assert 🎯: `leaveAllFlows` espera a estas promesas al desmontar una
    //    tabla; sin tope, cerrar la vista con el socket caido las dejaria
    //    colgadas una por fila.
    expect(ack).toEqual({ ok: false, reason: ACK_TIMEOUT });
  });
});
