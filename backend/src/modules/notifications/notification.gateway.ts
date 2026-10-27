import { Logger, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { isUUID } from 'class-validator';

import { CrudEventsCoordinator } from '@common/services/crud-events.coordinator';
import { SessionEventsCoordinator } from '@common/services/session-events.coordinator';
import { PricingEventsCoordinator } from '@common/services/pricing-events.coordinator';
import { ExecutionEventsCoordinator } from '@common/services/execution-events.coordinator';
import { IpAccessService } from '@common/services/ip-access.service';
import { WorkflowsService } from '@modules/workflows/workflows.service';
import { CRUD_EVENT } from '@common/types/crud-events.types';
import { SESSION_EVENT } from '@common/types/session-events.types';
import { PRICING_EVENT } from '@common/types/pricing-events.types';
import { EXECUTION_EVENT } from '@common/types/execution-events.types';
import {
  ADMIN_ONLY_ENTITIES,
  FLOW_ROOM_PREFIX,
  FORBIDDEN_ROOM,
  MAX_ROOMS_PER_SOCKET,
  resolveCorsOrigin,
  ROLE_ROOM_PREFIX,
  USER_ROOM_PREFIX,
  WS_DENIED_ORIGIN,
  WS_INVALID_TOKEN,
} from '@modules/notifications/notification.constants';

import type { CrudEventPort } from '@common/services/crud-events.coordinator';
import type { SessionEventPort } from '@common/services/session-events.coordinator';
import type { PricingEventPort } from '@common/services/pricing-events.coordinator';
import type { ExecutionEventPort } from '@common/services/execution-events.coordinator';
import type { CrudMutationPayload } from '@common/types/crud-events.types';
import type { UserModifiedPayload } from '@common/types/session-events.types';
import type { PricingUpdatedPayload } from '@common/types/pricing-events.types';
import type {
  FlowCompletedEvent,
  FlowDiscardedEvent,
  FlowPausedEvent,
  FlowResumedEvent,
  ExecutionUpdatedEvent,
  NodeCompletedEvent,
  NodeErrorEvent,
  NodeStartedEvent,
} from '@common/types/execution-events.types';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import type { JwtPayload } from '@modules/auth/interfaces/jwt-payload.interface';
import { UserRole } from '@modules/users/enums/user-role.enum';
import type { Server, Socket } from 'socket.io';

/** Identidad que el middleware del handshake deja resuelta en `socket.data`. */
interface AuthenticatedSocketData {
  userId: string;
  role: UserRole;
}

/** Acuse de las suscripciones a sala. */
interface RoomAck {
  ok: boolean;
  reason?: string;
}

/** Socket ya autenticado: `data` deja de ser un saco anonimo. */
type AuthenticatedSocket = Socket<
  Record<string, never>,
  Record<string, never>,
  Record<string, never>,
  AuthenticatedSocketData
>;

/** Cabecera de respaldo cuando el cliente no puede escribir `handshake.auth`. */
const BEARER_PREFIX = 'Bearer ';

/**
 * Canal de notificaciones en tiempo real del motor FSM
 * (`architecture-patterns.md` §4.4 y §5).
 *
 * ## Por que `path` va explicito
 *
 * `setGlobalPrefix('api')` de `main.ts` actua sobre el router de Nest, y el
 * adaptador de Socket.io NO pasa por ahi —es el mismo motivo por el que Swagger
 * vive en `/api/docs` montado a mano—. Sin esta linea el canal quedaria en
 * `/socket.io`, fuera del unico prefijo que el proxy corporativo enruta hacia el
 * backend. El cliente debe declarar el mismo `path`.
 *
 * ## Por que la autenticacion vive en un middleware y no en `handleConnection`
 *
 * Validar dentro de `handleConnection` obliga a ACEPTAR el handshake primero y
 * cerrarlo despues con `disconnect(true)`. El cliente ve entonces un evento
 * `disconnect` con motivo `io server disconnect`, que es exactamente el mismo
 * que recibe cuando el servidor se reinicia: indistinguible. Un middleware que
 * llama `next(error)` rechaza ANTES de establecer la conexion y produce un
 * `connect_error` con mensaje propio, que es lo que permite al cliente purgar
 * la sesion solo cuando la credencial es la que falla —y no cada vez que se
 * recarga Nest.
 */
@WebSocketGateway({
  namespace: '/events',
  path: '/api/socket.io',
  // `resolveCorsOrigin` es un CALLBACK a proposito: el decorador se evalua al
  // importar la clase, antes de que `ConfigModule` cargue el `.env`, asi que un
  // `process.env.FRONTEND_URL` leido aqui valdria `undefined` y el comodin de
  // respaldo es ilegal junto a `credentials: true` (el navegador rechaza
  // `Access-Control-Allow-Origin: *` cuando viajan credenciales).
  cors: { origin: resolveCorsOrigin, credentials: true },
})
export class NotificationGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy,
    ExecutionEventPort,
    CrudEventPort,
    SessionEventPort,
    PricingEventPort
{
  private readonly logger = new Logger(NotificationGateway.name);

  @WebSocketServer()
  private readonly server?: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly ipAccessService: IpAccessService,
    private readonly executionEvents: ExecutionEventsCoordinator,
    private readonly workflowsService: WorkflowsService,
    private readonly crudEvents: CrudEventsCoordinator,
    private readonly sessionEvents: SessionEventsCoordinator,
    private readonly pricingEvents: PricingEventsCoordinator,
  ) {}

  /**
   * Se inscribe como canal del motor.
   *
   * Se registra `this`, no un literal, para poder darse de baja con la misma
   * referencia en `onModuleDestroy`.
   */
  public onModuleInit(): void {
    this.executionEvents.register(this);
    this.crudEvents.registerPort(this);
    this.sessionEvents.registerPort(this);
    this.pricingEvents.registerPort(this);
  }

  /**
   * Sin esta baja, cada recarga del `--watch` dejaria en el coordinador un
   * gateway cuyo servidor ya esta cerrado, emitiendo al vacio junto al nuevo.
   */
  public onModuleDestroy(): void {
    this.executionEvents.unregister(this);
    this.crudEvents.unregisterPort(this);
    this.sessionEvents.unregisterPort(this);
    this.pricingEvents.unregisterPort(this);
  }

  /** Instala el filtro del handshake en cuanto existe el servidor del namespace. */
  public afterInit(server: Server): void {
    server.use((socket, next) => {
      // `void`: la firma del middleware de Socket.io es sincrona, asi que la
      // promesa se lanza y es ella quien invoca `next` en ambos desenlaces.
      void this.authenticateHandshake(socket, next);
    });
  }

  /**
   * Une a la sala privada del usuario. Llega aqui solo lo ya validado.
   *
   * La sala `user_*` existe para los avisos dirigidos a una persona concreta.
   * Los eventos de ejecucion NO van por aqui: se difunden por flujo, porque un
   * flujo lo vigila quien lo tenga abierto, no quien lo creo.
   */
  public async handleConnection(client: AuthenticatedSocket): Promise<void> {
    const { userId } = client.data;

    // Defensivo: si el middleware fallase en silencio, unir a `user_undefined`
    // crearia una sala compartida por todos los anonimos.
    if (!userId) {
      client.disconnect(true);
      return;
    }

    await client.join(`${USER_ROOM_PREFIX}${userId}`);

    // La sala de ROL es lo que permite difundir una mutacion administrativa sin
    // que la reciba un EDITOR. Se une aqui, y no bajo demanda como las salas de
    // flujo, porque el rol es un hecho del handshake y no una eleccion del
    // cliente: dejarlo a `@SubscribeMessage` seria dejar que el socket eligiera
    // su propio rol.
    const { role } = client.data;

    if (role) {
      await client.join(`${ROLE_ROOM_PREFIX}${role}`);
    }

    this.logger.log(
      `Socket conectado | usuario=${userId} | rol=${role ?? 'desconocido'} | id=${client.id}`,
    );
  }

  public handleDisconnect(client: AuthenticatedSocket): void {
    // Sin limpieza de salas: Socket.io las abandona solo al cerrarse el socket.
    this.logger.log(
      `Socket desconectado | usuario=${client.data.userId ?? 'desconocido'} | id=${client.id}`,
    );
  }

  /**
   * Suscribe el socket a los eventos de un flujo.
   *
   * Devuelve acuse en vez de emitir un evento de error aparte: es lo que
   * permite al cliente —y a una prueba— saber si la suscripcion entro sin tener
   * que leer el estado interno del adaptador.
   */
  @SubscribeMessage('flow:subscribe')
  public async subscribeToFlow(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: unknown,
  ): Promise<RoomAck> {
    const flowId = this.readFlowId(payload);

    // UUID estricto: el `flowId` se concatena para formar el nombre de la sala,
    // asi que sin validarlo un socket podria inscribirse en cadenas arbitrarias
    // —incluida una `user_*` ajena si el prefijo viajase en el valor.
    if (flowId === null) {
      return { ok: false, reason: 'El identificador de flujo no es un UUID.' };
    }

    // El middleware del handshake deja siempre la identidad resuelta; si
    // faltase, el socket no esta autenticado y no se le fia ninguna sala.
    const { userId } = client.data;

    if (userId === undefined || userId === '') {
      return { ok: false, reason: FORBIDDEN_ROOM };
    }

    // Paridad con HTTP: `workflows.controller.ts` expone los flujos a `ADMIN` y
    // `EDITOR` por igual, de modo que lo unico que se exige aqui es que el
    // flujo EXISTA. Filtrar ademas por `createdById` haria que un editor viese
    // en la tabla flujos cuya telemetria no recibiria nunca, y el canal WS no
    // es el sitio para estrenar una regla de acceso que REST no aplica.
    if (!(await this.flowExists(flowId))) {
      return { ok: false, reason: FORBIDDEN_ROOM };
    }

    // Se cuentan SOLO las salas de flujo: `client.rooms` incluye siempre la
    // sala propia del socket y la `user_*`, de modo que usar `rooms.size`
    // gastaria dos plazas del cupo en algo que el cliente no pidio.
    if (this.countFlowRooms(client) >= MAX_ROOMS_PER_SOCKET) {
      return {
        ok: false,
        reason: `Un socket no puede seguir mas de ${MAX_ROOMS_PER_SOCKET} flujos a la vez.`,
      };
    }

    await client.join(`${FLOW_ROOM_PREFIX}${flowId}`);

    return { ok: true };
  }

  /**
   * Comprueba si existe el flujo, traduciendo el 404 del servicio a un booleano.
   *
   * `WorkflowsService.findOne` lanza `NotFoundException` porque su llamador
   * natural es un controlador HTTP. Aqui no hay respuesta que mapear: un flujo
   * inexistente es una sala denegada, no un fallo del socket.
   */
  private async flowExists(flowId: string): Promise<boolean> {
    try {
      await this.workflowsService.findOne(flowId);

      return true;
    } catch (error) {
      if (error instanceof NotFoundException) {
        return false;
      }

      // Una caida de la base de datos no debe tumbar el socket: se deniega la
      // sala y se deja rastro, que es lo que distingue este caso del 404.
      this.logger.error(
        `No se pudo comprobar el flujo "${flowId}" al inscribir la sala.`,
        error instanceof Error ? error.stack : undefined,
      );

      return false;
    }
  }

  @SubscribeMessage('flow:unsubscribe')
  public async unsubscribeFromFlow(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: unknown,
  ): Promise<RoomAck> {
    const flowId = this.readFlowId(payload);

    if (flowId === null) {
      return { ok: false, reason: 'El identificador de flujo no es un UUID.' };
    }

    await client.leave(`${FLOW_ROOM_PREFIX}${flowId}`);

    return { ok: true };
  }

  public emitFlowPaused(event: FlowPausedEvent): void {
    this.emitToFlow(EXECUTION_EVENT.FLOW_PAUSED, event.flowId, event);
  }

  public emitFlowResumed(event: FlowResumedEvent): void {
    this.emitToFlow(EXECUTION_EVENT.FLOW_RESUMED, event.flowId, event);
  }

  public emitFlowDiscarded(event: FlowDiscardedEvent): void {
    this.emitToFlow(EXECUTION_EVENT.FLOW_DISCARDED, event.flowId, event);
  }

  /**
   * El cierre terminal va al NAMESPACE ENTERO, no a la sala del flujo.
   *
   * Es el unico evento de ejecucion que se difunde asi, y la asimetria es
   * deliberada: la pausa, la reanudacion y el descarte piden una accion sobre
   * un flujo concreto —solo interesan a quien lo esta mirando—, mientras que el
   * cierre con exito es la confirmacion de que el trabajo salio, y un operador
   * que lanzo un flujo y se fue a otra pantalla deberia enterarse igual. El
   * precedente esta en `emitCrudMutation`, que ya difunde asi todo lo que no es
   * `ADMIN_ONLY_ENTITIES`; y no filtra nada, porque ADMIN y EDITOR pueden
   * consultar cualquier flujo por REST.
   */
  public emitFlowCompleted(event: FlowCompletedEvent): void {
    // El `?.` no es decorativo, igual que en `emitToFlow`: el coordinador puede
    // despachar antes de que el adaptador haya montado el namespace.
    this.server?.emit(EXECUTION_EVENT.FLOW_COMPLETED, event);
  }

  public emitNodeError(event: NodeErrorEvent): void {
    this.emitToFlow(EXECUTION_EVENT.NODE_ERROR, event.flowId, event);
  }

  /**
   * El ciclo de vida del nodo va a la SALA, nunca al namespace entero.
   *
   * Es el caso opuesto a `emitFlowCompleted`: estos dos solo significan algo
   * para quien tiene ese canvas abierto en ese instante —son la animacion, no
   * el desenlace—, y nadie que mire otra pantalla gana nada con recibirlos.
   * Ademas es el par mas voluminoso del canal, dos eventos por intento de cada
   * nodo: difundirlos multiplicaria ese trafico por el numero de sockets
   * conectados para entregar a cada operador la animacion de flujos ajenos.
   */
  public emitNodeStarted(event: NodeStartedEvent): void {
    this.emitToFlow(EXECUTION_EVENT.NODE_STARTED, event.flowId, event);
  }

  public emitNodeCompleted(event: NodeCompletedEvent): void {
    this.emitToFlow(EXECUTION_EVENT.NODE_COMPLETED, event.flowId, event);
  }

  /**
   * Cambio de estado de una ejecucion, al NAMESPACE ENTERO.
   *
   * Mismo criterio que `emitFlowCompleted`: el historial de ejecuciones del
   * panel no se suscribe a ninguna sala de flujo, y sin este evento solo se
   * enteraba de una pausa o una reanudacion con un F5. El payload es minimo
   * (estado y cursor) y se emite una vez por transicion, no por nodo.
   */
  public emitExecutionUpdated(event: ExecutionUpdatedEvent): void {
    this.server?.emit(EXECUTION_EVENT.EXECUTION_UPDATED, event);
  }

  /**
   * Difunde una mutacion de tabla maestra a los paneles abiertos.
   *
   * El destino depende de la entidad, no del emisor: las administrativas van
   * SOLO a la sala de los administradores, porque un `server.emit` alcanzaria
   * tambien a los editores y les entregaria correos corporativos y rangos de
   * red que REST les niega. El resto se difunde al namespace entero, que ya
   * esta autenticado por el middleware del handshake.
   */
  public emitCrudMutation(payload: CrudMutationPayload): void {
    // El `?.` no es decorativo, igual que en `emitToFlow`: el coordinador puede
    // despachar antes de que el adaptador haya montado el namespace.
    if (ADMIN_ONLY_ENTITIES.has(payload.entity)) {
      this.server
        ?.to(`${ROLE_ROOM_PREFIX}${UserRole.ADMIN}`)
        .emit(CRUD_EVENT.MUTATION, payload);

      return;
    }

    this.server?.emit(CRUD_EVENT.MUTATION, payload);
  }

  /**
   * Avisa a UNA persona de que su cuenta dejo de ser la que era.
   *
   * PRIMER uso real de la sala `user_*`, que hasta ahora se creaba en
   * `handleConnection` y no tenia ningun emisor. Va dirigido y no difundido por
   * el motivo evidente: el payload nombra al autor del cambio y los campos
   * tocados, y eso no es asunto del resto de la plantilla.
   *
   * Alcanza a TODAS las pestanas y dispositivos de esa persona, porque cada
   * socket suyo se unio a la misma sala al conectarse. Es lo que se quiere: la
   * sesion se cierra en todos sus clientes a la vez.
   *
   * El aviso es la CORTESIA, no la medida de seguridad. Quien de verdad corta
   * la sesion es `usuarios.token_version`, ya escrita en PostgreSQL cuando esto
   * corre; un cliente desconectado no se entera del modal, pero su siguiente
   * peticion recibe un 401 igual.
   */
  public emitUserModified(payload: UserModifiedPayload): void {
    this.server
      ?.to(`${USER_ROOM_PREFIX}${payload.userId}`)
      .emit(SESSION_EVENT.USER_MODIFIED, payload);
  }

  /**
   * Avisa a los ADMIN de que un par (proveedor, modelo) estrena tarifa.
   *
   * SOLO a la sala de administradores: el CRUD de tarifas es exclusivo de ese
   * rol, y un `server.emit` entregaria a los editores un aviso de una pantalla
   * que REST les niega.
   */
  public emitPricingUpdated(payload: PricingUpdatedPayload): void {
    this.server
      ?.to(`${ROLE_ROOM_PREFIX}${UserRole.ADMIN}`)
      .emit(PRICING_EVENT.UPDATED, payload);
  }

  /**
   * Valida origen y credencial del handshake.
   *
   * Orden deliberado —perimetro antes que credencial—, el mismo que impone
   * `security-and-scope.md` §1: una IP fuera de rango se rechaza sin llegar a
   * procesar el token.
   */
  private async authenticateHandshake(
    socket: Socket,
    next: (error?: Error) => void,
  ): Promise<void> {
    const { handshake } = socket;

    const originAllowed = await this.ipAccessService.isOriginAllowed({
      headers: handshake.headers,
      // El handshake expone la direccion remota plana; `extractClientIp` la
      // espera donde la pone Node en una peticion HTTP.
      socket: { remoteAddress: handshake.address },
    });

    if (!originAllowed) {
      next(new Error(WS_DENIED_ORIGIN));
      return;
    }

    const token = this.readHandshakeToken(socket);

    if (token === null) {
      next(new Error(WS_INVALID_TOKEN));
      return;
    }

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);

      if (!payload?.sub || !payload.role) {
        next(new Error(WS_INVALID_TOKEN));
        return;
      }

      const data = socket.data as AuthenticatedSocketData;
      data.userId = payload.sub;
      data.role = payload.role;

      next();
    } catch (error) {
      // El motivo tecnico (firma, caducidad) se queda en el log: al cliente
      // solo le hace falta saber que su credencial no sirve.
      this.logger.warn(
        `Handshake rechazado | id=${socket.id} | motivo=${error instanceof Error ? error.message : String(error)}`,
      );
      next(new Error(WS_INVALID_TOKEN));
    }
  }

  /** Token del handshake, con respaldo en la cabecera `Authorization`. */
  private readHandshakeToken(socket: Socket): string | null {
    const fromAuth: unknown = socket.handshake.auth?.token;

    if (typeof fromAuth === 'string' && fromAuth.length > 0) {
      return fromAuth;
    }

    const header = socket.handshake.headers.authorization;

    if (typeof header === 'string' && header.startsWith(BEARER_PREFIX)) {
      const bearer = header.slice(BEARER_PREFIX.length).trim();

      if (bearer.length > 0) {
        return bearer;
      }
    }

    return null;
  }

  /** `flowId` del mensaje, o `null` si no viene o no es un UUID. */
  private readFlowId(payload: unknown): string | null {
    const raw =
      typeof payload === 'string'
        ? payload
        : ((payload as { flowId?: unknown } | null)?.flowId ?? null);

    return typeof raw === 'string' && isUUID(raw) ? raw : null;
  }

  private countFlowRooms(client: AuthenticatedSocket): number {
    let total = 0;

    for (const room of client.rooms) {
      if (room.startsWith(FLOW_ROOM_PREFIX)) {
        total += 1;
      }
    }

    return total;
  }

  /**
   * El `?.` del servidor no es cosmetico: el coordinador puede despachar un
   * evento antes de que el adaptador haya montado el namespace, y en ese
   * instante `@WebSocketServer()` todavia no ha inyectado nada.
   */
  private emitToFlow(
    eventName: string,
    flowId: string,
    payload:
      | FlowPausedEvent
      | FlowResumedEvent
      | FlowDiscardedEvent
      | FlowCompletedEvent
      | NodeErrorEvent
      | NodeStartedEvent
      | NodeCompletedEvent,
  ): void {
    this.server?.to(`${FLOW_ROOM_PREFIX}${flowId}`).emit(eventName, payload);
  }
}
