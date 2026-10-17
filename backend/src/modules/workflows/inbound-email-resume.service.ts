import { Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { simpleParser } from 'mailparser';

import { FsmExecutionQueryService } from '@core/fsm/services/fsm-execution-query.service';
// Del util y no de `pause-flow.strategy`, que solo lo reexportaba: un servicio
// importando de una estrategia es la direccion equivocada —aquella es un
// detalle de ejecucion de un nodo concreto y esto verifica testigos de
// cualquiera—, y esa reexportacion ademas tumbaba `nest build`.
import { hashResumeToken } from '@common/utils/resume-token.util';
import { createImapClient } from '@modules/nodes/services/imap-client.factory';
import { PASSWORD_ENV_KEY_PATTERN } from '@modules/nodes/dto/imap-trigger-config.dto';
import { UserRole } from '@modules/users/enums/user-role.enum';
import { UsersService } from '@modules/users/users.service';
import { Workflow } from '@modules/workflows/entities/workflow.entity';

import { ExecutionsService } from './executions.service';

import type { ResolvedImapConfig } from '@modules/nodes/dto/imap-trigger-config.dto';
import type { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';
import type { User } from '@modules/users/entities/user.entity';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ImapFlow, MailboxLockObject } from 'imapflow';
import type { ParsedMail } from 'mailparser';
import type { Repository } from 'typeorm';

/**
 * Texto que se acepta como orden de reanudacion.
 *
 * `REANUDAR <testigo>` o `REANUDAR <testigo> DESDE <paso>`, con sus equivalentes
 * en ingles. El identificador del flujo NO aparece: la ejecucion la determina el
 * testigo, y un UUID de produccion es un dato que no conviene pasear por buzones
 * ajenos ni por los registros de los servidores intermedios.
 *
 * El testigo es HEXADECIMAL: lo produce `randomBytes(n).toString('hex')`, asi
 * que admitir el alfabeto alfanumerico completo solo ensanchaba la superficie
 * de lo que hay que probar contra la base. La horquilla de longitud cubre los
 * dos emisores —el nodo `PAUSA_FLOW` y el de alerta— sin atarse a ninguno.
 */
const RESUME_COMMAND_REGEX =
  /^(?:REANUDAR|RESUME)\s+([a-f0-9]{8,64})(?:\s+(?:DESDE|FROM)\s+([a-zA-Z0-9_-]+))?$/i;

/**
 * Prefijos de respuesta y reenvio que los clientes acumulan en el asunto.
 *
 * `Re:`, `RE:`, `Rv:`, `Fwd:`… y encadenados (`Re: Re: ...`). Son justo lo que
 * rompia la lectura por asunto: la orden llega SIEMPRE como respuesta al aviso,
 * nunca redactada desde cero.
 */
const SUBJECT_REPLY_PREFIXES = /^(?:\s*(?:re|rv|fw|fwd)\s*:\s*)+/i;

/**
 * Donde empieza la cita del correo original dentro de una respuesta.
 *
 * Por debajo de cualquiera de estas marcas viene el aviso entero, que incluye
 * LITERALMENTE el texto `REANUDAR <testigo>` que el propio sistema escribio.
 * Sin cortar ahi, toda respuesta —incluso un "recibido, gracias"— casaria con
 * la orden y reanudaria el flujo sin que nadie lo hubiera pedido.
 */
const QUOTED_BLOCK_MARKERS: readonly RegExp[] = [
  /^\s*>/,
  /^\s*--\s*$/,
  /^\s*_{5,}\s*$/,
  /^\s*-{5,}\s*(?:mensaje original|original message)/i,
  /^\s*el\s+.+\s+escribi(?:o|ó)\s*:/i,
  /^\s*on\s+.+\s+wrote\s*:/i,
  /^\s*de\s*:\s*/i,
  /^\s*from\s*:\s*/i,
];

/**
 * Primera linea util del cuerpo, descontada la cita y la firma.
 *
 * Helper PURO (`frontend-architecture.md` §2.1 aplica el mismo criterio en
 * backend): sin estado ni E/S, para poder probarlo contra cuerpos reales.
 *
 * Devuelve `null` cuando no queda nada que mirar, que es lo que empuja a la
 * llamada a probar con el asunto.
 */
export const extractCommandLine = (rawBody: string): string | null => {
  for (const line of rawBody.split(/\r?\n/)) {
    if (QUOTED_BLOCK_MARKERS.some((marker) => marker.test(line))) {
      // No se sigue buscando: de aqui para abajo es texto del sistema, no del
      // operador.
      return null;
    }

    const trimmed = line.trim();

    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return null;
};

/** Asunto sin los `Re:`/`Fwd:` acumulados. */
export const cleanSubject = (rawSubject: string): string =>
  rawSubject.replace(SUBJECT_REPLY_PREFIXES, '').trim();

/** Roles que pueden dar la orden. Mismos que los de la API. */
const AUTHORIZED_ROLES: ReadonlySet<UserRole> = new Set([
  UserRole.ADMIN,
  UserRole.EDITOR,
]);

/** Cuantos mensajes se atienden por vuelta, para no bloquear el proceso. */
const MAX_COMMANDS_PER_RUN = 10;

/** Inactividad maxima del socket durante la descarga de un mensaje. */
const SOCKET_TIMEOUT_MS = 30_000;

/** Nombre del intervalo en el `SchedulerRegistry`, para poder darlo de baja. */
const RESUME_POLL_INTERVAL_NAME = 'inbound-resume-poll';

/**
 * Cada cuanto se mira el buzon de ordenes si no se declara otra cosa.
 *
 * Un minuto, como el sondeo de los flujos: la orden la da una persona que acaba
 * de recibir un aviso y esta esperando a que su flujo arranque, asi que la
 * latencia se nota. Mas abajo no compensa — cada vuelta abre una conexion IMAP.
 */
const DEFAULT_RESUME_POLL_MS = 60_000;

/** Suelo del intervalo: por debajo se maltrata al servidor de correo. */
const MIN_RESUME_POLL_MS = 15_000;

/** Lo que se extrae de un mensaje antes de decidir nada. */
interface InboundCommand {
  /** `null` cuando la orden no viene de un barrido del buzon propio. */
  readonly uid: number | null;
  readonly fromAddress: string;
  readonly token: string;
  readonly targetIdentifier: string | null;
}

/**
 * Reanuda ejecuciones detenidas desde una orden que llega por correo.
 *
 * ## Por que el remitente NO es la credencial
 *
 * SMTP no autentica la cabecera `From`: ponerla es escribir una linea de texto.
 * Ademas el correo entra desde Internet, de modo que esta via no pasa por el
 * `RedLocalMiddleware` que filtra por subred, ni por el OTP, ni por el JWT —las
 * tres capas que `security-and-scope.md` declara obligatorias—. Con el remitente
 * como unica prueba, cualquiera que supiera la direccion del buzon podria
 * reanudar ejecuciones de produccion.
 *
 * Por eso la credencial es un TESTIGO de un solo uso que genera el nodo
 * `PAUSA_FLOW` al avisar de la pausa, y que solo conoce quien recibio ese aviso.
 * De el se persiste unicamente la huella SHA-256, dentro del contexto de la
 * ejecucion. El remitente se sigue comprobando —tiene que existir, estar activo
 * y tener rol suficiente—, pero como segundo factor y no como el primero.
 *
 * Tres propiedades salen gratis de donde vive el testigo:
 *
 * 1. **Un solo uso**, sin tabla ni migracion: al reanudar, la ejecucion deja de
 *    estar PAUSADO y la huella ya no casa con ninguna candidata.
 * 2. **Atado a una ejecucion concreta**, no al flujo: un testigo filtrado no
 *    sirve para la siguiente pausa.
 * 3. **Sin aviso no hay canal**: una pausa configurada sin `notifyOnPause` no
 *    genera testigo y por tanto no es reanudable por correo. Es una propiedad
 *    deseable, no una carencia.
 *
 * ## Lo que este servicio NO relaja
 *
 * El despacho final pasa por `ExecutionsService.resumeExecution`, el mismo que
 * usa la API: las guardas de estado, la revalidacion del esquema, el techo de
 * ejecuciones simultaneas y el rechazo de los saltos hacia adelante siguen
 * aplicando igual. Este servicio decide QUIEN pide y QUE ejecucion, nunca si la
 * reanudacion es legal.
 */
@Injectable()
export class InboundEmailResumeService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(InboundEmailResumeService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly executionQueryService: FsmExecutionQueryService,
    private readonly executionsService: ExecutionsService,
    private readonly usersService: UsersService,
    @InjectRepository(Workflow)
    private readonly workflowRepository: Repository<Workflow>,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  /**
   * Programa el barrido periodico del buzon de ordenes.
   *
   * SIN ESTO el canal no existia. `processInbox` estaba escrito y probado, pero
   * no lo invocaba nadie en produccion —ni cron, ni intervalo, ni endpoint—, de
   * modo que una orden de reanudacion enviada al buzon propio se quedaba ahi
   * para siempre. El unico camino vivo era el del buzon del flujo, y ese solo
   * existe desde que `ImapTriggerStrategy` delega.
   *
   * Apagado por defecto (`INBOUND_RESUME_ENABLED`), igual que el sondeo de
   * flujos: una instalacion que no lo configure no abre ninguna conexion.
   */
  public onModuleInit(): void {
    if (this.configService.get<string>('INBOUND_RESUME_ENABLED') !== 'true') {
      this.logger.warn(
        '[InboundEmailResume] Canal de ordenes por correo deshabilitado (INBOUND_RESUME_ENABLED != "true").',
      );

      return;
    }

    const intervalMs = this.resolvePollInterval();

    // `processInbox` no lanza por una orden invalida, pero si puede hacerlo si
    // el servidor de correo esta caido. El `catch` evita que un rechazo sin
    // atrapar derribe el proceso desde el bucle de eventos del temporizador.
    const interval = setInterval(() => {
      void this.processInbox().catch((error: unknown) => {
        this.logger.error(
          `[InboundEmailResume] Fallo el barrido del buzon de ordenes: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, intervalMs);

    this.schedulerRegistry.addInterval(RESUME_POLL_INTERVAL_NAME, interval);

    this.logger.log(
      `[InboundEmailResume] Buzon de ordenes vigilado cada ${intervalMs} ms.`,
    );
  }

  /**
   * Da de baja el intervalo.
   *
   * Sin esto, una recarga del `--watch` de Nest dejaria el temporizador viejo
   * corriendo contra una instancia muerta, junto al de la instancia nueva: dos
   * barridos simultaneos sobre el mismo buzon.
   */
  public onModuleDestroy(): void {
    if (
      this.schedulerRegistry.doesExist('interval', RESUME_POLL_INTERVAL_NAME)
    ) {
      this.schedulerRegistry.deleteInterval(RESUME_POLL_INTERVAL_NAME);
    }
  }

  /**
   * Lee `INBOUND_RESUME_POLL_MS` y lo acota.
   *
   * Lo que no sea un entero por encima del suelo se descarta con aviso y se cae
   * al defecto: un intervalo mal escrito que se tomase al pie de la letra
   * podria convertir el barrido en una tormenta de conexiones.
   */
  private resolvePollInterval(): number {
    const raw = this.configService.get<string>('INBOUND_RESUME_POLL_MS');

    if (raw === undefined || raw.trim() === '') {
      return DEFAULT_RESUME_POLL_MS;
    }

    const parsed = Number(raw);

    if (!Number.isInteger(parsed) || parsed < MIN_RESUME_POLL_MS) {
      this.logger.warn(
        `[InboundEmailResume] INBOUND_RESUME_POLL_MS="${raw}" no es un entero >= ${MIN_RESUME_POLL_MS}; se usa ${DEFAULT_RESUME_POLL_MS} ms.`,
      );

      return DEFAULT_RESUME_POLL_MS;
    }

    return parsed;
  }

  /**
   * Lee el buzon de ordenes y atiende lo que encuentre.
   *
   * Devuelve cuantas ordenes se despacharon de verdad; el resto se descartan en
   * silencio para quien las envio y con un aviso en el registro para quien
   * opera el sistema.
   *
   * NO LANZA por una orden invalida: un mensaje que no se entiende no puede
   * dejar sin atender a los que vienen detras en el mismo lote.
   */
  public async processInbox(): Promise<number> {
    const config = this.resolveMailboxConfig();

    if (config === null) {
      return 0;
    }

    const password = this.configService.get<string>(config.passwordEnvKey);

    if (password === undefined || password === '') {
      this.logger.error(
        `[InboundEmailResume] La variable ${config.passwordEnvKey} no esta declarada: el buzon de ordenes no se puede abrir.`,
      );

      return 0;
    }

    const client = createImapClient(
      config,
      password,
      (error: Error) => {
        this.logger.warn(
          `[InboundEmailResume] Error de socket contra el buzon: ${error.message}`,
        );
      },
      SOCKET_TIMEOUT_MS,
    );

    let lock: MailboxLockObject | undefined;
    let dispatched = 0;

    try {
      await client.connect();
      lock = await client.getMailboxLock(config.mailbox);

      const uids = await client.search({ seen: false }, { uid: true });

      if (uids === false || !Array.isArray(uids) || uids.length === 0) {
        return 0;
      }

      for (const uid of uids.slice(0, MAX_COMMANDS_PER_RUN)) {
        // El marcado va en el `finally` de cada mensaje y NO al final del lote:
        // un comando que no se marca se vuelve a leer en la vuelta siguiente, y
        // uno que falla a mitad dejaria el buzon reprocesandose para siempre.
        try {
          const handled = await this.handleMessage(client, uid);

          if (handled) {
            dispatched += 1;
          }
        } catch (error: unknown) {
          this.logger.error(
            `[InboundEmailResume] El mensaje uid=${uid} no se pudo atender: ${this.describe(error)}`,
          );
        } finally {
          await this.markSeen(client, uid);
        }
      }

      return dispatched;
    } catch (error: unknown) {
      this.logger.error(
        `[InboundEmailResume] No se pudo leer el buzon de ordenes: ${this.describe(error)}`,
      );

      return dispatched;
    } finally {
      lock?.release();
      await this.logoutQuietly(client);
    }
  }

  /**
   * Descarga un mensaje, lo valida de principio a fin y lo despacha.
   *
   * Devuelve `true` solo si la ejecucion llego a reanudarse.
   */
  private async handleMessage(client: ImapFlow, uid: number): Promise<boolean> {
    const download = await client.download(String(uid), undefined, {
      uid: true,
    });

    return this.processMessage(await simpleParser(download.content), uid);
  }

  /**
   * Atiende un mensaje YA parseado: lo valida de principio a fin y lo despacha.
   *
   * Publico porque tiene DOS entradas, y las dos tienen que pasar por las
   * mismas guardas. La primera es el barrido de este servicio sobre su buzon
   * propio (`INBOUND_RESUME_*`). La segunda es `ImapTriggerStrategy`, que se
   * topa con la orden en el buzon QUE SONDEA EL FLUJO: el operador responde al
   * correo de alerta y su respuesta cae ahi, no en el buzon de ordenes. Sin
   * esta puerta, aquella estrategia tendria que reimplementar la validacion del
   * testigo y el RBAC, y dos copias de una comprobacion de seguridad divergen.
   *
   * Recibe un `ParsedMail` y no un UID justamente por eso: la estrategia ya lo
   * ha descargado y parseado, y volver a bajarlo con otro cliente IMAP seria
   * pedir dos veces el mismo mensaje.
   *
   * @param parsed Mensaje decodificado por `mailparser`.
   * @param uid UID de origen, solo para la traza; `null` si no viene de un
   *        barrido propio.
   * @returns `true` solo si la ejecucion llego a reanudarse.
   */
  public async processMessage(
    parsed: ParsedMail,
    uid: number | null = null,
  ): Promise<boolean> {
    const command = this.extractCommand(parsed, uid);

    if (command === null) {
      return false;
    }

    // --- 1. El testigo. Va PRIMERO, antes incluso de mirar quien escribe: sin
    // credencial valida no hay nada que discutir, y preguntar a la base de
    // datos por el remitente de un mensaje cualquiera convertiria el buzon en
    // un oraculo de que direcciones estan dadas de alta.
    const execution = await this.findExecutionByToken(command.token);

    if (execution === null) {
      this.logger.warn(
        `[InboundEmailResume] Intento no autorizado desde: ${command.fromAddress} (testigo desconocido, caducado o ya usado)`,
      );

      return false;
    }

    // --- 2. Quien escribe. Segundo factor: el testigo prueba que esa persona
    // recibio el aviso, y esto que sigue teniendo permiso hoy.
    const user = await this.resolveAuthorizedUser(command.fromAddress);

    if (user === null) {
      return false;
    }

    // --- 3. El paso, si lo pidio. Un identificador que no resuelve NO aborta:
    // se reanuda desde donde se detuvo, que es lo que el operador queria de
    // todas formas. Abortar por una errata en un nombre de nodo dejaria el
    // flujo parado por un detalle que el correo no permite corregir.
    const targetStepId = await this.resolveTargetStep(
      execution,
      command.targetIdentifier,
    );

    await this.executionsService.resumeExecution(
      execution.executionId,
      targetStepId === null ? {} : { targetStepId },
      user,
      { isEmailResume: true },
    );

    this.logger.log(
      `[InboundEmailResume] Ejecucion ${execution.executionId} reanudada por ${user.email}${
        targetStepId === null ? '' : ` desde "${targetStepId}"`
      }`,
    );

    return true;
  }

  /**
   * Extrae la orden del mensaje, o `null` si no lo es.
   *
   * DOS VIAS, y el cuerpo manda sobre el asunto. El cuerpo es donde se le pide
   * al operador que escriba, y es la unica via que sobrevive a un cliente que
   * reescribe el asunto; el asunto queda de respaldo para quien responde sin
   * texto util, que con una firma automatica delante es frecuente.
   *
   * Las dos pasan por la MISMA expresion y con anclaje completo: un cuerpo que
   * traiga la orden mas cualquier cosa detras se rechaza. Es deliberado y es lo
   * que impide que una respuesta larga que mencione el comando de pasada acabe
   * reanudando un flujo.
   */
  private extractCommand(
    parsed: ParsedMail,
    uid: number | null,
  ): InboundCommand | null {
    const candidates = [
      extractCommandLine(parsed.text ?? ''),
      cleanSubject(parsed.subject ?? ''),
    ];

    const match = candidates.reduce<RegExpExecArray | null>(
      (found, candidate) =>
        found ??
        (candidate === null || candidate.length === 0
          ? null
          : RESUME_COMMAND_REGEX.exec(candidate)),
      null,
    );

    if (match === null) {
      // Ni un `warn`: un buzon recibe correo que no son ordenes, y avisar de
      // cada uno llenaria el registro de ruido que nadie puede accionar.
      this.logger.debug(
        `[InboundEmailResume] Mensaje uid=${uid ?? 'n/d'} ignorado: ni el cuerpo ni el asunto son una orden.`,
      );

      return null;
    }

    const fromAddress = (
      parsed.from?.value?.[0]?.address ??
      parsed.from?.text ??
      ''
    )
      .trim()
      .toLowerCase();

    return {
      uid,
      fromAddress,
      token: match[1] ?? '',
      targetIdentifier: match[2] ?? null,
    };
  }

  /**
   * Busca la ejecucion detenida cuyo testigo casa, si no ha caducado.
   *
   * Se recorren en memoria las ejecuciones PAUSADO: son pocas por definicion
   * —cada una reclama atencion de una persona— y el testigo vive dentro de un
   * `jsonb`, sin columna por la que filtrar.
   */
  private async findExecutionByToken(
    token: string,
  ): Promise<FsmExecution | null> {
    const candidates = await this.executionQueryService.findPausedWithContext();
    const expected = hashResumeToken(token);

    for (const candidate of candidates) {
      for (const namespace of Object.values(candidate.contextPayload ?? {})) {
        const stored = namespace?.resume_token_hash;

        if (typeof stored !== 'string' || stored !== expected) {
          continue;
        }

        const expiresAt = namespace?.token_expires_at;

        if (
          typeof expiresAt === 'string' &&
          Date.parse(expiresAt) < Date.now()
        ) {
          this.logger.warn(
            `[InboundEmailResume] Testigo caducado para la ejecucion ${candidate.executionId}.`,
          );

          return null;
        }

        return candidate;
      }
    }

    return null;
  }

  /** El remitente, si existe, sigue activo y tiene rol suficiente. */
  private async resolveAuthorizedUser(
    fromAddress: string,
  ): Promise<AuthenticatedUser | null> {
    if (fromAddress === '') {
      this.logger.warn(
        '[InboundEmailResume] Intento no autorizado desde: (remitente ausente)',
      );

      return null;
    }

    const user: User | null = await this.usersService.findByEmail(fromAddress);

    if (user === null || !user.isActive || !AUTHORIZED_ROLES.has(user.role)) {
      this.logger.warn(
        `[InboundEmailResume] Intento no autorizado desde: ${fromAddress}`,
      );

      return null;
    }

    return { id: user.id, email: user.email, role: user.role };
  }

  /**
   * Traduce lo que el operador escribio tras "DESDE" a un `nodeId`.
   *
   * Acepta las tres formas con las que una persona nombra un paso de memoria:
   * su identificador, su tipo o el namespace que publica. Sin distinguir
   * mayusculas, porque un asunto de correo pasa por varios clientes que lo
   * reescriben.
   */
  private async resolveTargetStep(
    execution: FsmExecution,
    identifier: string | null,
  ): Promise<string | null> {
    if (identifier === null) {
      return null;
    }

    const workflow = await this.workflowRepository.findOne({
      where: { id: execution.flowId },
    });
    const nodes = (
      workflow?.pipelineSchema as
        { nodes?: Record<string, Record<string, unknown>> } | null | undefined
    )?.nodes;

    if (nodes === undefined) {
      return null;
    }

    const wanted = identifier.trim().toLowerCase();

    for (const [nodeId, node] of Object.entries(nodes)) {
      const candidates = [
        nodeId,
        typeof node.nodeType === 'string' ? node.nodeType : '',
        typeof node.outputNamespace === 'string' ? node.outputNamespace : '',
      ];

      if (candidates.some((value) => value.toLowerCase() === wanted)) {
        return nodeId;
      }
    }

    this.logger.warn(
      `[InboundEmailResume] El paso "${identifier}" no existe en el flujo ${execution.flowId}: se reanuda desde donde se detuvo.`,
    );

    return null;
  }

  /**
   * Configuracion del buzon de ordenes, o `null` si el canal esta apagado.
   *
   * Buzon PROPIO y no el de ningun flujo: el de un flujo lo elige quien edita
   * ese flujo, y un EDITOR podria entonces redirigir el canal de mando a un
   * servidor suyo. Este se declara en el entorno, que solo toca quien despliega.
   *
   * Apagado por defecto, igual que `IMAP_POLLING_ENABLED`: una instalacion que
   * no lo configure no abre ninguna conexion ni expone ninguna superficie.
   */
  private resolveMailboxConfig(): ResolvedImapConfig | null {
    if (this.configService.get<string>('INBOUND_RESUME_ENABLED') !== 'true') {
      return null;
    }

    const host = this.configService.get<string>('INBOUND_RESUME_IMAP_HOST');
    const user = this.configService.get<string>('INBOUND_RESUME_IMAP_USER');
    const passwordEnvKey =
      this.configService.get<string>('INBOUND_RESUME_IMAP_PASSWORD_KEY') ?? '';

    if (host === undefined || user === undefined || passwordEnvKey === '') {
      this.logger.error(
        '[InboundEmailResume] El canal esta habilitado pero faltan INBOUND_RESUME_IMAP_HOST, _USER o _PASSWORD_KEY.',
      );

      return null;
    }

    // Misma guarda que el nodo IMAP: sin ella, apuntar la clave a `JWT_SECRET`
    // la entregaria al servidor de correo en el saludo de autenticacion.
    if (!PASSWORD_ENV_KEY_PATTERN.test(passwordEnvKey)) {
      this.logger.error(
        `[InboundEmailResume] INBOUND_RESUME_IMAP_PASSWORD_KEY="${passwordEnvKey}" no cumple el patron IMAP_*PASSWORD.`,
      );

      return null;
    }

    return {
      host,
      port: Number(
        this.configService.get<string>('INBOUND_RESUME_IMAP_PORT') ?? 993,
      ),
      secure: true,
      user,
      passwordEnvKey,
      mailbox:
        this.configService.get<string>('INBOUND_RESUME_IMAP_MAILBOX') ??
        'INBOX',
      pollIntervalMs: 0,
      outputNamespace: 'raw_email',
      markAsRead: true,
      fromFilter: null,
      subjectFilter: null,
      subjectFilterRegex: null,
      unreadOnly: true,
      includeAttachments: false,
      maxAttachmentBytes: 0,
    };
  }

  /**
   * Marca el mensaje como leido, pase lo que pase con el.
   *
   * Tambien los rechazados: un comando que no se marca se vuelve a leer en cada
   * vuelta, de modo que un intento no autorizado quedaria reintentandose solo
   * para siempre y llenaria el registro de la misma advertencia.
   */
  private async markSeen(client: ImapFlow, uid: number): Promise<void> {
    try {
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    } catch (error: unknown) {
      this.logger.warn(
        `[InboundEmailResume] No se pudo marcar como leido el uid=${uid}: ${this.describe(error)}`,
      );
    }
  }

  /** Cierra la sesion sin dejar que un fallo de salida tape el resultado. */
  private async logoutQuietly(client: ImapFlow): Promise<void> {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : 'causa desconocida';
  }
}
