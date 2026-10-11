import { NotFoundException } from '@nestjs/common';

import { ExecutionEventsCoordinator } from '@common/services/execution-events.coordinator';
import { EXECUTION_EVENT } from '@common/types/execution-events.types';
import {
  FLOW_ROOM_PREFIX,
  FORBIDDEN_ROOM,
  MAX_ROOMS_PER_SOCKET,
  USER_ROOM_PREFIX,
  WS_DENIED_ORIGIN,
  WS_INVALID_TOKEN,
} from '@modules/notifications/notification.constants';
import { NotificationGateway } from '@modules/notifications/notification.gateway';
import { UserRole } from '@modules/users/enums/user-role.enum';

import type { IpAccessService } from '@common/services/ip-access.service';
import type { NodeErrorEvent } from '@common/types/execution-events.types';
import type { JwtService } from '@nestjs/jwt';
import type { Server, Socket } from 'socket.io';

const FLOW_ID = 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const USER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const TOKEN = 'token.firmado.valido';

const NODE_ERROR: NodeErrorEvent = {
  executionId: '11111111-2222-4333-8444-555555555555',
  flowId: FLOW_ID,
  emittedAt: '2026-10-10T08:00:00.000Z',
  nodeId: 'nodo_ia',
  severity: 'GRAVE',
  errorCode: 'ERR_LLM_TIMEOUT',
  errorMessage: 'Tiempo agotado.',
  logFilePath: '/logs/execution-2026-10-10.log',
  attempt: 1,
};

interface SocketMock {
  id: string;
  data: Record<string, unknown>;
  rooms: Set<string>;
  handshake: {
    auth: Record<string, unknown>;
    headers: Record<string, string>;
    address: string;
  };
  join: jest.Mock;
  leave: jest.Mock;
  disconnect: jest.Mock;
}

/**
 * Socket doble. `join` alimenta el `Set` de salas porque el techo de
 * `MAX_ROOMS_PER_SOCKET` se cuenta justamente sobre el, y un doble que no lo
 * actualizase haria pasar la prueba del tope sin probar nada.
 */
const buildSocket = (overrides: Partial<SocketMock> = {}): SocketMock => {
  const rooms = overrides.rooms ?? new Set<string>();

  return {
    id: 'socket-1',
    // El middleware del handshake deja la identidad resuelta antes de que
    // llegue ningun `flow:subscribe`; el doble arranca en ese mismo estado.
    data: overrides.data ?? { userId: USER_ID, role: UserRole.EDITOR },
    rooms,
    handshake: {
      auth: { token: TOKEN },
      headers: {},
      address: '127.0.0.1',
    },
    join: jest.fn((room: string) => {
      rooms.add(room);
      return Promise.resolve();
    }),
    leave: jest.fn((room: string) => {
      rooms.delete(room);
      return Promise.resolve();
    }),
    disconnect: jest.fn(),
    ...overrides,
  };
};

/** Firma del middleware que Socket.io recibe en `server.use`. */
type HandshakeMiddleware = (
  socket: Socket,
  next: (error?: Error) => void,
) => void;

interface Harness {
  gateway: NotificationGateway;
  jwtService: { verifyAsync: jest.Mock };
  ipAccessService: { isOriginAllowed: jest.Mock };
  coordinator: ExecutionEventsCoordinator;
  workflowsService: { findOne: jest.Mock };
  emit: jest.Mock;
  to: jest.Mock;
  use: jest.Mock;
  server: Server;
}

const buildHarness = (): Harness => {
  const jwtService = {
    verifyAsync: jest.fn().mockResolvedValue({
      sub: USER_ID,
      email: 'a@b.c',
      role: UserRole.EDITOR,
    }),
  };
  const ipAccessService = {
    isOriginAllowed: jest.fn().mockResolvedValue(true),
  };
  const coordinator = new ExecutionEventsCoordinator();
  const workflowsService = {
    findOne: jest.fn().mockResolvedValue({ id: FLOW_ID }),
  };

  const gateway = new NotificationGateway(
    jwtService as unknown as JwtService,
    ipAccessService as unknown as IpAccessService,
    coordinator,
    workflowsService as unknown as WorkflowsService,
  );

  jest.spyOn(gateway['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(gateway['logger'], 'warn').mockImplementation(() => undefined);

  const emit = jest.fn();
  const to = jest.fn().mockReturnValue({ emit });
  const use = jest.fn();
  const server = { to, use } as unknown as Server;

  // `@WebSocketServer()` lo inyecta Nest en tiempo de arranque; aqui se siembra
  // a mano porque el gateway se instancia suelto, sin modulo.
  (gateway as unknown as { server?: Server }).server = server;

  return {
    gateway,
    jwtService,
    ipAccessService,
    coordinator,
    workflowsService,
    emit,
    to,
    use,
    server,
  };
};

/** Ejecuta el middleware que `afterInit` instala y devuelve lo que paso a `next`. */
const runHandshake = async (
  harness: Harness,
  socket: SocketMock,
): Promise<Error | undefined> => {
  harness.gateway.afterInit(harness.server);

  // Se tipa la lista de llamadas en vez de leer un `any`: `mock.calls` es
  // `any[][]`, y desestructurarlo en crudo dispara `no-unsafe-member-access`.
  const calls = harness.use.mock.calls as Array<[HandshakeMiddleware]>;
  const middleware = calls[0]?.[0];

  if (middleware === undefined) {
    throw new Error('`afterInit` no inscribio ningun middleware de handshake.');
  }

  return new Promise<Error | undefined>((resolve) => {
    middleware(socket as unknown as Socket, resolve);
  });
};

describe('NotificationGateway (canal WebSocket de eventos de ejecucion)', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('1. Filtro del handshake', () => {
    it('1.1 deberia admitir un handshake con IP autorizada y token valido', async () => {
      // 1. Arrange
      const harness = buildHarness();
      const socket = buildSocket();

      // 2. Act
      const error = await runHandshake(harness, socket);

      // 3. Assert
      expect(error).toBeUndefined();
      expect(socket.data.userId).toBe(USER_ID);
      expect(socket.data.role).toBe(UserRole.EDITOR);
    });

    // El perimetro va ANTES que la credencial (`security-and-scope.md` §1): una
    // IP fuera de rango se rechaza sin llegar a procesar el token.
    it('1.2 deberia rechazar una IP fuera del rango corporativo sin verificar el token', async () => {
      // 1. Arrange
      const harness = buildHarness();
      harness.ipAccessService.isOriginAllowed.mockResolvedValue(false);
      const socket = buildSocket();

      // 2. Act
      const error = await runHandshake(harness, socket);

      // 3. Assert
      expect(error?.message).toBe(WS_DENIED_ORIGIN);
      expect(harness.jwtService.verifyAsync).not.toHaveBeenCalled();
    });

    it('1.3 deberia rechazar un handshake sin token', async () => {
      // 1. Arrange
      const harness = buildHarness();
      const socket = buildSocket();
      socket.handshake.auth = {};

      // 2. Act
      const error = await runHandshake(harness, socket);

      // 3. Assert
      expect(error?.message).toBe(WS_INVALID_TOKEN);
    });

    it('1.4 deberia rechazar un token que no verifica', async () => {
      // 1. Arrange
      const harness = buildHarness();
      harness.jwtService.verifyAsync.mockRejectedValue(
        new Error('jwt expired'),
      );
      const socket = buildSocket();

      // 2. Act
      const error = await runHandshake(harness, socket);

      // 3. Assert: el motivo tecnico se queda en el log, no viaja al cliente.
      expect(error?.message).toBe(WS_INVALID_TOKEN);
    });

    it('1.5 deberia rechazar un token valido cuyo payload no trae sub', async () => {
      // 1. Arrange: un token firmado con otro proposito verifica, pero no
      //    identifica a nadie; unir ese socket a `user_undefined` crearia una
      //    sala compartida por todos los anonimos.
      const harness = buildHarness();
      harness.jwtService.verifyAsync.mockResolvedValue({
        role: UserRole.ADMIN,
      });
      const socket = buildSocket();

      // 2. Act
      const error = await runHandshake(harness, socket);

      // 3. Assert
      expect(error?.message).toBe(WS_INVALID_TOKEN);
    });

    it('1.6 deberia aceptar el token por la cabecera Authorization como respaldo', async () => {
      // 1. Arrange
      const harness = buildHarness();
      const socket = buildSocket();
      socket.handshake.auth = {};
      socket.handshake.headers = { authorization: `Bearer ${TOKEN}` };

      // 2. Act
      const error = await runHandshake(harness, socket);

      // 3. Assert
      expect(error).toBeUndefined();
      expect(harness.jwtService.verifyAsync).toHaveBeenCalledWith(TOKEN);
    });
  });

  describe('2. Salas', () => {
    it('2.1 deberia unir el socket autenticado a su sala privada', async () => {
      // 1. Arrange
      const { gateway } = buildHarness();
      const socket = buildSocket();
      socket.data = { userId: USER_ID, role: UserRole.EDITOR };

      // 2. Act
      await gateway.handleConnection(socket as unknown as never);

      // 3. Assert
      expect(socket.join).toHaveBeenCalledWith(`${USER_ROOM_PREFIX}${USER_ID}`);
    });

    it('2.2 deberia unir a la sala del flujo con un UUID valido', async () => {
      // 1. Arrange
      const { gateway } = buildHarness();
      const socket = buildSocket();

      // 2. Act
      const ack = await gateway.subscribeToFlow(socket as unknown as never, {
        flowId: FLOW_ID,
      });

      // 3. Assert
      expect(ack.ok).toBe(true);
      expect(socket.join).toHaveBeenCalledWith(`${FLOW_ROOM_PREFIX}${FLOW_ID}`);
    });

    // El `flowId` se concatena para formar el nombre de la sala: sin validarlo,
    // un socket podria inscribirse en cadenas arbitrarias, incluida una `user_*`.
    it('2.3 NO deberia unir a una sala si el flowId no es un UUID', async () => {
      // 1. Arrange
      const { gateway } = buildHarness();
      const socket = buildSocket();

      // 2. Act
      const ack = await gateway.subscribeToFlow(socket as unknown as never, {
        flowId: 'user_otro',
      });

      // 3. Assert
      expect(ack.ok).toBe(false);
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('2.4 deberia rechazar al alcanzar el techo de salas por socket', async () => {
      // 1. Arrange: se llena solo de salas `flow_*`.
      const { gateway } = buildHarness();
      const rooms = new Set<string>();
      for (let index = 0; index < MAX_ROOMS_PER_SOCKET; index += 1) {
        rooms.add(`${FLOW_ROOM_PREFIX}ocupada-${index}`);
      }
      const socket = buildSocket({ rooms });

      // 2. Act
      const ack = await gateway.subscribeToFlow(socket as unknown as never, {
        flowId: FLOW_ID,
      });

      // 3. Assert
      expect(ack.ok).toBe(false);
      expect(socket.join).not.toHaveBeenCalled();
    });

    // `client.rooms` incluye siempre la sala propia del socket y la `user_*`:
    // contar `rooms.size` gastaria dos plazas del cupo en algo que nadie pidio.
    it('2.5 NO deberia contar la sala propia ni la de usuario en el cupo', async () => {
      // 1. Arrange
      const { gateway } = buildHarness();
      const rooms = new Set<string>([
        'socket-1',
        `${USER_ROOM_PREFIX}${USER_ID}`,
      ]);
      for (let index = 0; index < MAX_ROOMS_PER_SOCKET - 1; index += 1) {
        rooms.add(`${FLOW_ROOM_PREFIX}ocupada-${index}`);
      }
      const socket = buildSocket({ rooms });

      // 2. Act
      const ack = await gateway.subscribeToFlow(socket as unknown as never, {
        flowId: FLOW_ID,
      });

      // 3. Assert
      expect(ack.ok).toBe(true);
    });

    it('2.5bis deberia denegar la sala de un flujo inexistente', async () => {
      // 1. Arrange 📐: `findOne` lanza 404 cuando no hay fila.
      const harness = buildHarness();
      harness.workflowsService.findOne.mockRejectedValue(
        new NotFoundException('No existe el flujo.'),
      );
      const socket = buildSocket();

      // 2. Act ⚙️
      const ack = await harness.gateway.subscribeToFlow(
        socket as unknown as never,
        { flowId: FLOW_ID },
      );

      // 3. Assert 🎯: sin esta guarda, cualquier socket autenticado podia
      // inscribirse en `flow_<uuid>` arbitrarios y sondear que llega.
      expect(ack).toEqual({ ok: false, reason: FORBIDDEN_ROOM });
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('2.5ter deberia denegar la sala a un socket sin identidad resuelta', async () => {
      // 1. Arrange 📐
      const { gateway } = buildHarness();
      const socket = buildSocket({ data: {} });

      // 2. Act ⚙️
      const ack = await gateway.subscribeToFlow(socket as unknown as never, {
        flowId: FLOW_ID,
      });

      // 3. Assert 🎯
      expect(ack).toEqual({ ok: false, reason: FORBIDDEN_ROOM });
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('2.5quater deberia admitir a un EDITOR en la sala de un flujo existente', async () => {
      // 1. Arrange 📐: paridad con HTTP. `workflows.controller.ts` expone los
      // flujos a ADMIN y EDITOR por igual, asi que el rol no discrimina salas.
      const harness = buildHarness();
      const socket = buildSocket({
        data: { userId: USER_ID, role: UserRole.EDITOR },
      });

      // 2. Act ⚙️
      const ack = await harness.gateway.subscribeToFlow(
        socket as unknown as never,
        { flowId: FLOW_ID },
      );

      // 3. Assert 🎯
      expect(ack).toEqual({ ok: true });
      expect(socket.join).toHaveBeenCalledWith(`${FLOW_ROOM_PREFIX}${FLOW_ID}`);
    });

    it('2.5quinquies deberia admitir a un ADMIN en la sala de un flujo existente', async () => {
      // 1. Arrange 📐
      const harness = buildHarness();
      const socket = buildSocket({
        data: { userId: USER_ID, role: UserRole.ADMIN },
      });

      // 2. Act ⚙️
      const ack = await harness.gateway.subscribeToFlow(
        socket as unknown as never,
        { flowId: FLOW_ID },
      );

      // 3. Assert 🎯
      expect(ack).toEqual({ ok: true });
      expect(socket.join).toHaveBeenCalledWith(`${FLOW_ROOM_PREFIX}${FLOW_ID}`);
    });

    it('2.6 deberia abandonar la sala del flujo al desuscribirse', async () => {
      // 1. Arrange
      const { gateway } = buildHarness();
      const socket = buildSocket();

      // 2. Act
      const ack = await gateway.unsubscribeFromFlow(
        socket as unknown as never,
        {
          flowId: FLOW_ID,
        },
      );

      // 3. Assert
      expect(ack.ok).toBe(true);
      expect(socket.leave).toHaveBeenCalledWith(
        `${FLOW_ROOM_PREFIX}${FLOW_ID}`,
      );
    });
  });

  describe('3. Emision a la sala del flujo', () => {
    it('3.1 deberia emitir node:error a flow_<flowId>', () => {
      // 1. Arrange
      const { gateway, to, emit } = buildHarness();

      // 2. Act
      gateway.emitNodeError(NODE_ERROR);

      // 3. Assert
      expect(to).toHaveBeenCalledWith(`${FLOW_ROOM_PREFIX}${FLOW_ID}`);
      expect(emit).toHaveBeenCalledWith(EXECUTION_EVENT.NODE_ERROR, NODE_ERROR);
    });

    // El coordinador puede despachar antes de que el adaptador monte el
    // namespace: en ese instante `@WebSocketServer()` aun no inyecto nada.
    it('3.2 NO deberia lanzar si el servidor todavia no existe', () => {
      // 1. Arrange
      const { gateway } = buildHarness();
      (gateway as unknown as { server?: Server }).server = undefined;

      // 2. Act & 3. Assert
      expect(() => gateway.emitNodeError(NODE_ERROR)).not.toThrow();
    });
  });

  describe('4. Alta y baja como canal del motor', () => {
    it('4.1 deberia inscribirse y recibir lo que publique el coordinador', () => {
      // 1. Arrange
      const { gateway, coordinator, emit } = buildHarness();

      // 2. Act
      gateway.onModuleInit();
      coordinator.emitNodeError(NODE_ERROR);

      // 3. Assert
      expect(emit).toHaveBeenCalledWith(EXECUTION_EVENT.NODE_ERROR, NODE_ERROR);
    });

    // Sin la baja, cada recarga del `--watch` dejaria aqui un gateway muerto
    // emitiendo al vacio junto a la instancia nueva.
    it('4.2 deberia darse de baja en onModuleDestroy', () => {
      // 1. Arrange
      const { gateway, coordinator, emit } = buildHarness();
      gateway.onModuleInit();

      // 2. Act
      gateway.onModuleDestroy();
      coordinator.emitNodeError(NODE_ERROR);

      // 3. Assert
      expect(emit).not.toHaveBeenCalled();
    });
  });
});
