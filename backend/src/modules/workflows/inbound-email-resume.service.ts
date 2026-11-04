import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { simpleParser } from 'mailparser';

import { FsmExecutionQueryService } from '@core/fsm/services/fsm-execution-query.service';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
// Del util y no de `pause-flow.strategy`, que solo lo reexportaba: un servicio
// importando de una estrategia es la direccion equivocada —aquella es un
// detalle de ejecucion de un nodo concreto y esto verifica testigos de
// cualquiera—, y esa reexportacion ademas tumbaba `nest build`.
import { hashResumeToken } from '@common/utils/resume-token.util';
import { isTransientNetworkError } from '@common/utils/network-errors.util';
import {
  closeImapClientQuietly,
  createImapClient,
} from '@modules/nodes/services/imap-client.factory';
import { PASSWORD_ENV_KEY_PATTERN } from '@modules/nodes/dto/imap-trigger-config.dto';
import { tokenizeSubject } from '@modules/nodes/strategies/imap-filter.util';
import {
  ERR_POST_IA_CONFIG,
  ERR_POST_IA_UNSUPPORTED_TAGS,
} from '@modules/nodes/strategies/post-ia-sanitizer.strategy';
import { AlertQueryService } from '@modules/logs/services/alert-query.service';
import { SubjectMatchMode } from '@modules/nodes/strategies/imap-trigger.types';
import { UserRole } from '@modules/users/enums/user-role.enum';
import { UsersService } from '@modules/users/users.service';
import { NodeCatalogEntry } from '@modules/nodes/entities/node-catalog.entity';
import { Workflow } from '@modules/workflows/entities/workflow.entity';

import { ExecutionsService } from './executions.service';

import type { ResolvedImapConfig } from '@modules/nodes/dto/imap-trigger-config.dto';
import type { ImapClientTimeouts } from '@modules/nodes/services/imap-client.factory';
import type { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';
import type { WorkflowExecutionResponseDto } from '@modules/workflows/dto/workflow-execution-response.dto';
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
 *
 * El grupo del paso es ANCHO (`.+?`) y no un alfabeto cerrado. Antes era
 * `[a-zA-Z0-9_-]+`, y como la expresion esta anclada de principio a fin, una
 * orden perfectamente valida que nombrara el paso por su etiqueta —`DESDE
 * Disparador IMAP`— no casaba con NADA: el mensaje se descartaba como "esto no
 * es una orden" y el operador no recibia ni el aviso de paso irresoluble. El
 * anclaje se conserva, que es lo que impide que una respuesta larga reanude un
 * flujo de pasada; quien acota lo que es un paso valido es `resolveTargetStep`,
 * que para eso conoce el grafo.
 */
const RESUME_COMMAND_REGEX =
  /^(?:REANUDAR|REANUDA|RESUME)[\s_]+([a-f0-9]{8,64})(?:[\s_]+(?:DESDE|DESE|DE|FROM)[\s_]+(.+?))?\s*$/i;

/**
 * Pista RAPIDA de que una linea es una orden, sin anclar el final.
 *
 * La usa `ImapTriggerStrategy` para apartar los mensajes de mando del contenido
 * del flujo; la validacion completa sigue siendo `RESUME_COMMAND_REGEX`. Vive
 * aqui, junto a ella, para que las dos puertas no diverjan: antes el disparador
 * solo reconocia `reanudar` y una orden `RESUME` entraba como contenido.
 */
const RESUME_COMMAND_HINT =
  /^(?:\s*(?:re|rv|fw|fwd)\s*:\s*)*(?:reanudar|reanuda|resume)[\s_]+[a-f0-9]{8,64}\b/i;

/**
 * Pliega diacriticos y espacios raros antes de evaluar una orden.
 *
 * NO compacta separadores (eso es `normalizeStepKey`, para nombrar el paso):
 * aqui el espacio separa verbo, testigo y paso, y la expresion los admite
 * igualmente separados por `_`. El testigo es hexadecimal y no le afecta.
 */
const foldCommandText = (raw: string): string =>
  raw
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[\u00A0\u2000-\u200B]/g, ' ');

/** `true` si el asunto o la linea parecen una orden de reanudacion. */
export const looksLikeResumeCommand = (line: string): boolean =>
  RESUME_COMMAND_HINT.test(foldCommandText(line).trim());

/**
 * Lee la orden de una linea ya aislada: testigo y paso nombrado, o `null`.
 *
 * Helper PURO. Tolera las erratas habituales del conector (`DESE`, `DE`) y el
 * verbo sin la `r` final; el anclaje de principio a fin se mantiene.
 */
export const parseResumeCommand = (
  line: string,
): {
  readonly token: string;
  readonly targetIdentifier: string | null;
} | null => {
  const match = RESUME_COMMAND_REGEX.exec(foldCommandText(line).trim());

  if (match === null) {
    return null;
  }

  const target = match[2]?.trim() ?? '';

  return {
    token: (match[1] ?? '').toLowerCase(),
    targetIdentifier: target.length === 0 ? null : target,
  };
};

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

/**
 * Clave compacta de un nombre de paso: sin tildes, en minusculas y sin
 * espacios, guiones ni signos ("Destino Drupal" → "destinodrupal").
 *
 * Helper PURO. Compactar hace equivalentes «Trigger IMAP», «trigger-imap» y
 * «TRIGGER_IMAP» sin tener que adivinar el separador que uso el operador.
 */
export const normalizeStepKey = (raw: string): string =>
  raw
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * Diccionario de sinonimos → `nodeType`, con las claves ya compactadas.
 *
 * Es el ULTIMO recurso de `resolveTargetStep`: etiqueta, identificador y tipo
 * reales del grafo se prueban antes. Cubre lo que el operador escribe de
 * memoria, mezclando idiomas o nombrando el namespace en vez del nodo.
 */
export const STEP_ALIASES: Readonly<Record<string, string>> = {
  triggerimap: 'TRIGGER_IMAP',
  disparadorimap: 'TRIGGER_IMAP',
  imap: 'TRIGGER_IMAP',
  triggercron: 'TRIGGER_CRON',
  disparadorcron: 'TRIGGER_CRON',
  cron: 'TRIGGER_CRON',
  parser: 'PARSER_PRE_IA',
  parserdecorreo: 'PARSER_PRE_IA',
  parsercorreo: 'PARSER_PRE_IA',
  extractorweb: 'EXTRACTOR_WEB',
  scraper: 'EXTRACTOR_WEB',
  webscraper: 'EXTRACTOR_WEB',
  procesadorocr: 'PROCESADOR_OCR',
  ocr: 'PROCESADOR_OCR',
  ocria: 'PROCESADOR_OCR',
  mapeador: 'MAPEADOR_PLANTILLA',
  mapeadorplantilla: 'MAPEADOR_PLANTILLA',
  mapeadordeplantilla: 'MAPEADOR_PLANTILLA',
  mapeadorhtml: 'MAPEADOR_PLANTILLA',
  renderhtml: 'MAPEADOR_PLANTILLA',
  renderedhtml: 'MAPEADOR_PLANTILLA',
  procesadoria: 'PROCESADOR_IA',
  procesadordeia: 'PROCESADOR_IA',
  ia: 'PROCESADOR_IA',
  llm: 'PROCESADOR_IA',
  llmresponse: 'PROCESADOR_IA',
  escudo: 'ESCUDO_POST_IA',
  escudopostia: 'ESCUDO_POST_IA',
  escudoposterioraia: 'ESCUDO_POST_IA',
  postia: 'ESCUDO_POST_IA',
  pausa: 'PAUSA_FLOW',
  pausadeflujo: 'PAUSA_FLOW',
  pausaflujo: 'PAUSA_FLOW',
  pausaflow: 'PAUSA_FLOW',
  pausecontext: 'PAUSA_FLOW',
  destinodrupal: 'DESTINO_DRUPAL',
  drupal: 'DESTINO_DRUPAL',
  destinoacens: 'DESTINO_ACENS',
  acens: 'DESTINO_ACENS',
};

/**
 * Palabras vacias que se descartan al nombrar un paso por sus palabras.
 *
 * Articulos, preposiciones y los sustantivos genericos con que el operador
 * envuelve el nombre ("DESDE EL NODO escudo post ia", "desde el paso del
 * mapeador"): ningun nodo los lleva como rasgo distintivo, y conservarlos
 * haria imposible la coincidencia. Se descartan tambien del lado del nodo, de
 * modo que un id como `nodo_c` queda reducido a lo que de verdad lo nombra.
 */
export const STEP_STOPWORDS: ReadonlySet<string> = new Set([
  'el',
  'la',
  'los',
  'las',
  'de',
  'del',
  'al',
  'en',
  'nodo',
  'nodos',
  'paso',
  'pasos',
  'step',
  'node',
]);

/**
 * Codigos del escudo que NO se arreglan regenerando la respuesta de la IA.
 *
 * Los dos describen los `params` del propio escudo (configuracion invalida o
 * etiquetas fuera de la lista blanca). Volver a la IA gastaria tokens para
 * fallar exactamente igual en el escudo; con ellos se reanuda donde se pidio.
 */
const NON_REGENERABLE_POST_IA_CODES: ReadonlySet<string> = new Set([
  ERR_POST_IA_CONFIG,
  ERR_POST_IA_UNSUPPORTED_TAGS,
]);

/** Prefijo comun de los codigos de fallo de `ESCUDO_POST_IA`. */
const POST_IA_ERROR_PREFIX = 'ERR_POST_IA_';

/**
 * `true` si el fallo del escudo se debe a la RESPUESTA de la IA y, por tanto,
 * se corrige regenerandola: DOM mutado, marcadores residuales, markup vacio...
 */
export const isRegenerablePostIaError = (code: string | null): boolean =>
  code !== null &&
  code.startsWith(POST_IA_ERROR_PREFIX) &&
  !NON_REGENERABLE_POST_IA_CODES.has(code);

/** Forma minima de un nodo del esquema que lee este servicio. */
type SchemaNode = Record<string, unknown>;

/**
 * El nodo que produce lo que audita un escudo, o `null`.
 *
 * Primero por contrato de datos: el nodo cuyo `outputNamespace` es el
 * `sourceNamespace` del escudo (por defecto `llm_response`, el del
 * `PROCESADOR_IA`). Si ninguno lo declara, por topologia: el nodo cuyo
 * `nextStep` es el escudo. Helper PURO.
 */
export const findShieldProducer = (
  nodes: Readonly<Record<string, SchemaNode>>,
  shieldId: string,
): string | null => {
  const params = nodes[shieldId]?.params as SchemaNode | undefined;
  const sourceNamespace =
    typeof params?.sourceNamespace === 'string'
      ? params.sourceNamespace
      : 'llm_response';
  const entries = Object.entries(nodes).filter(
    ([nodeId]) => nodeId !== shieldId,
  );
  const byNamespace = entries.find(
    ([, node]) => node.outputNamespace === sourceNamespace,
  );

  if (byNamespace !== undefined) {
    return byNamespace[0];
  }

  return entries.find(([, node]) => node.nextStep === shieldId)?.[0] ?? null;
};

/**
 * Parte el nombre de un paso en palabras utiles.
 *
 * Helper PURO. Delega en `tokenizeSubject`, el MISMO que usa el filtro de
 * asunto de `TRIGGER_IMAP`: quien configura un flujo aprende una sola regla de
 * normalizacion (sin tildes, minusculas, sin signos) y le vale para las dos
 * puertas. Ese tokenizador corta por todo lo que no es letra ni digito, `_`
 * incluido, y eso es imprescindible aqui: `mapeador_plantilla` tiene que dar
 * dos palabras para que «plantilla mapeador» lo encuentre.
 */
export const tokenizeStepWords = (raw: string): string[] =>
  tokenizeSubject(raw).filter((token) => !STEP_STOPWORDS.has(token));

/**
 * `true` si TODAS las palabras pedidas estan entre las del nodo, en cualquier
 * orden. Sin palabras pedidas no hay coincidencia: un «DESDE de la» no puede
 * elegir el primer nodo del grafo por accidente.
 */
export const matchesStepWords = (
  queryTokens: readonly string[],
  candidateTokens: ReadonlySet<string>,
): boolean =>
  queryTokens.length > 0 &&
  queryTokens.every((token) => candidateTokens.has(token));

/** Roles que pueden dar la orden. Mismos que los de la API. */
const AUTHORIZED_ROLES: ReadonlySet<UserRole> = new Set([
  UserRole.ADMIN,
  UserRole.EDITOR,
]);

/** Cuantos mensajes se atienden por vuelta, para no bloquear el proceso. */
const MAX_COMMANDS_PER_RUN = 10;

/**
 * Cuantos UID ajenos se recuerdan antes de olvidar los mas antiguos.
 *
 * Holgado respecto a lo que cabe en un buzon de ordenes sano, y aun asi
 * acotado: `Set` conserva el orden de insercion, de modo que descartar desde el
 * principio tira siempre lo mas viejo. Lo peor que pasa al olvidar un UID es
 * que ese mensaje se vuelva a descargar una vez.
 */
const MAX_SKIPPED_UIDS = 500;

/**
 * Temporizadores del cliente IMAP del canal de ordenes.
 *
 * Mas cortos que los de la fabrica en la CONEXION (45 s frente a 60 s) y mas
 * holgados en la inactividad (60 s frente a 30 s), por la naturaleza del
 * worker: corre en segundo plano cada minuto, de modo que rendirse antes ante un
 * servidor que no contesta solo cuesta esperar al ciclo siguiente, mientras que
 * colgarse en la conexion encadenaba ciclos saltados por `isPolling`. Una vez
 * conectado, en cambio, viaja un MIME completo y un corte prematuro tiraria una
 * orden valida a medio descargar.
 */
const RESUME_IMAP_TIMEOUTS: ImapClientTimeouts = {
  connectionTimeoutMs: 45_000,
  greetingTimeoutMs: 30_000,
  socketTimeoutMs: 60_000,
};

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

/**
 * Espera MINIMA entre sondeos que exige el contrato del canal (5 s).
 *
 * Es una cota inferior documentada, no el intervalo efectivo: el suelo real
 * (`MIN_RESUME_POLL_MS`) y el defecto (`DEFAULT_RESUME_POLL_MS`) ya la
 * superan, y ningun valor de `INBOUND_RESUME_POLL_MS` puede bajar de ella.
 */
export const RESUME_MAIL_POLL_INTERVAL_MS = 5_000;

/**
 * Que se hizo con un mensaje del buzon, para decidir si se marca `\Seen`.
 *
 * Las dos respuestas son independientes: una orden con un testigo caducado es
 * `wasCommand: true, dispatched: false`, y hay que marcarla igual —ya se
 * atendio, y dejarla sin marcar la reprocesaria cada minuto para volver a
 * rechazarla.
 */
interface HandledMessage {
  /** El mensaje ERA una orden de reanudacion, aunque fuese rechazada. */
  readonly wasCommand: boolean;
  /** La ejecucion llego a reanudarse. */
  readonly dispatched: boolean;
}

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

  /**
   * Hay un barrido del buzon en curso.
   *
   * GLOBAL y no por flujo —a diferencia del `inFlight` de
   * `ImapPollingService`— porque aqui solo hay un buzon: el de ordenes. El
   * intervalo dispara sin preguntar, de modo que un ciclo que tarda mas que el
   * periodo abria una segunda sesion IMAP contra el MISMO buzon mientras la
   * primera seguia descargando. Las dos veian los mismos mensajes sin marcar y
   * las dos los despachaban: una orden de reanudacion ejecutada por duplicado.
   * Con un enlace lento —justo el caso que motiva este cambio— las sesiones se
   * apilaban una por minuto.
   */
  private isPolling = false;

  /**
   * UID del buzon que ya se miraron y NO eran una orden.
   *
   * Existe porque este servicio dejo de marcar `\Seen` el correo ajeno. Antes
   * lo marcaba TODO lo que leia, y eso convertia el canal de ordenes en un
   * lector de correo que vaciaba de no-leidos un buzon que puede ser el mismo
   * que sondea un `TRIGGER_IMAP`: el flujo configurado con `markAsRead: false`
   * veia sus correos marcados por la espalda, por un servicio que solo venia a
   * buscar comandos.
   *
   * El canje es deliberado: se cambia una marca en el servidor por un recuerdo
   * en memoria. Tras un reinicio esos mensajes se vuelven a descargar y parsear
   * UNA vez, lo que cuesta una descarga por mensaje y ninguna consulta a la
   * base —`extractCommand` descarta antes de preguntar nada—. A cambio, el
   * buzon del operador queda exactamente como estaba.
   *
   * Acotado por `MAX_SKIPPED_UIDS`: un buzon compartido con mucho trafico haria
   * crecer el conjunto sin techo durante toda la vida del proceso.
   */
  private readonly skippedUids = new Set<number>();

  /**
   * Ejecuciones reanudadas desde este canal cuyo recorrido sigue en marcha.
   *
   * La guarda es POR EJECUCION y no global. El barrido ya no espera a que el
   * flujo reanudado termine —esperarlo bloqueaba las ordenes de cualquier otra
   * ejecucion durante minutos—, asi que dos ordenes sobre el MISMO testigo en
   * el mismo lote, o en ciclos seguidos, llegarian a preparar la reanudacion
   * dos veces antes de que el motor marcase la fila EN_PROCESO. Con esto la
   * segunda se reconoce como duplicada y no toca nada; las de otras ejecuciones
   * siguen su curso en paralelo.
   */
  private readonly resumingExecutions = new Set<string>();

  constructor(
    private readonly configService: ConfigService,
    private readonly executionQueryService: FsmExecutionQueryService,
    private readonly executionsService: ExecutionsService,
    private readonly usersService: UsersService,
    @InjectRepository(Workflow)
    private readonly workflowRepository: Repository<Workflow>,
    // El catalogo se inyecta como REPOSITORIO y no como `NodeCatalogService`:
    // de aquel solo hace falta el par `codigo`/`nombre`, mientras que el
    // servicio arrastra ademas la `NodeStrategyFactory` para marcar que tipos
    // estan implementados. Depender de el obligaria a exportarlo de
    // `NodesModule` y ataria este canal a la factoria de estrategias por un
    // diccionario de dos columnas.
    @InjectRepository(NodeCatalogEntry)
    private readonly nodeCatalogRepository: Repository<NodeCatalogEntry>,
    private readonly schedulerRegistry: SchedulerRegistry,
    // Solo lectura de la traza: la guarda anti-bucle del escudo necesita el
    // ultimo codigo de error del nodo, que no vive en la ejecucion.
    private readonly alertQueryService: AlertQueryService,
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
    // ANTES de resolver nada: si el ciclo anterior sigue vivo, este tick sobra
    // entero. Se sale SIN tocar `isPolling`, que es del ciclo que lo armo.
    if (this.isPolling) {
      this.logger.warn(
        '[InboundEmailResume] El barrido anterior sigue en curso; se omite este ciclo.',
      );

      return 0;
    }

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

    // Se arma aqui y no en la guarda: las dos salidas anteriores (sin buzon
    // configurado, sin contrasena) no abren conexion alguna, y marcarlas como
    // "barrido en curso" obligaria a desarmar el flag en cada `return`.
    this.isPolling = true;

    const client = createImapClient(
      config,
      password,
      (error: Error) => {
        this.logger.warn(
          `[InboundEmailResume] Error de socket contra el buzon: ${error.message}`,
        );
      },
      RESUME_IMAP_TIMEOUTS,
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

      // El descarte va ANTES del `slice` y no despues. Los mensajes ajenos se
      // quedan sin marcar a proposito, de modo que el servidor los sigue
      // devolviendo en cada busqueda de no-leidos: filtrarlos al final dejaria
      // que una conversacion larga copara las diez plazas del lote y las
      // ordenes reales no se atenderian nunca.
      // Orden ASCENDENTE de UID: las respuestas de un mismo hilo se atienden en
      // el orden en que llegaron, y una segunda orden nunca adelanta a la
      // primera. El servidor no garantiza el orden de la respuesta a SEARCH.
      const pending = [...uids]
        .sort((left, right) => left - right)
        .filter((uid) => !this.skippedUids.has(uid))
        .slice(0, MAX_COMMANDS_PER_RUN);

      for (const uid of pending) {
        // El marcado va en el `finally` de cada mensaje y NO al final del lote:
        // una orden que no se marca se vuelve a leer en la vuelta siguiente, y
        // una que falla a mitad dejaria el buzon reprocesandose para siempre.
        //
        // Pero SOLO se marca lo que era una orden. Marcar tambien el correo
        // ajeno era la fuga que anulaba `markAsRead: false` en el buzon que
        // comparten este canal y el `TRIGGER_IMAP` del flujo. Lo que no es una
        // orden se recuerda en `skippedUids` y se deja intacto.
        let outcome: HandledMessage = { wasCommand: true, dispatched: false };

        try {
          outcome = await this.handleMessage(client, uid);

          if (outcome.dispatched) {
            dispatched += 1;
          }
        } catch (error: unknown) {
          // Se conserva `wasCommand: true` del valor inicial: si la cosa reviento
          // a mitad no hay forma de saber que era, y marcarlo es el lado seguro
          // —evita el bucle infinito de reintentar un mensaje que siempre falla.
          this.logger.error(
            `[InboundEmailResume] El mensaje uid=${uid} no se pudo atender: ${this.describe(error)}`,
          );
        } finally {
          if (outcome.wasCommand) {
            await this.markSeen(client, uid);
          } else {
            this.rememberSkipped(uid);
          }
        }
      }

      return dispatched;
    } catch (error: unknown) {
      // Un corte de enlace no es una averia del buzon de ordenes: se resuelve
      // solo en cuanto vuelve la ruta, y el intervalo sigue programado para
      // recogerlo. Registrarlo como `error` convertia cada apagado de VPN en
      // una traza roja que no describia ningun problema que atender.
      if (isTransientNetworkError(error)) {
        this.logger.warn(
          '[InboundEmailResume] Enlace no disponible temporalmente. Reintentando en el siguiente ciclo...',
        );

        return dispatched;
      }

      this.logger.error(
        `[InboundEmailResume] No se pudo leer el buzon de ordenes: ${this.describe(error)}`,
      );

      return dispatched;
    } finally {
      // `releaseQuietly` y no `lock?.release()` desnudo: sobre una conexion ya
      // rota la liberacion lanza, y esa excepcion escapaba del `finally`
      // saltandose el cierre del cliente —el unico paso que destruye el socket—
      // y tapando ademas el error original del `catch`.
      this.releaseQuietly(lock);
      await this.logoutQuietly(client);
      this.isPolling = false;
    }
  }

  /**
   * Descarga un mensaje, lo valida de principio a fin y lo despacha.
   *
   * Devuelve las DOS cosas que el barrido necesita saber: si era una orden
   * —que es lo que decide el `\Seen`— y si llego a reanudar. No se delega en
   * `processMessage` porque aquel solo responde lo segundo, y deducir lo
   * primero desde fuera exigiria volver a pasar la expresion sobre el mensaje.
   */
  private async handleMessage(
    client: ImapFlow,
    uid: number,
  ): Promise<HandledMessage> {
    const download = await client.download(String(uid), undefined, {
      uid: true,
    });
    const command = this.extractCommand(
      await simpleParser(download.content),
      uid,
    );

    if (command === null) {
      return { wasCommand: false, dispatched: false };
    }

    return {
      wasCommand: true,
      dispatched: await this.dispatchCommand(command),
    };
  }

  /**
   * Anota un UID como "ya mirado y no era una orden".
   *
   * Descarta el mas antiguo al llegar al tope. `Set` itera en orden de
   * insercion, asi que la primera clave es siempre la mas vieja.
   */
  private rememberSkipped(uid: number): void {
    if (this.skippedUids.size >= MAX_SKIPPED_UIDS) {
      const oldest = this.skippedUids.values().next();

      if (oldest.done !== true) {
        this.skippedUids.delete(oldest.value);
      }
    }

    this.skippedUids.add(uid);
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

    return this.dispatchCommand(command);
  }

  /**
   * Aplica las tres guardas a una orden ya extraida y la despacha.
   *
   * Separado de `processMessage` para que el barrido del buzon propio pueda
   * distinguir "no era una orden" de "era una orden y se rechazo" sin volver a
   * parsear el mensaje: de esa distincion depende si se marca `\Seen`.
   *
   * @returns `true` solo si la ejecucion llego a reanudarse.
   */
  private async dispatchCommand(command: InboundCommand): Promise<boolean> {
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

    // --- 4. Guarda por ejecucion: su recorrido anterior sigue en marcha.
    if (this.resumingExecutions.has(execution.executionId)) {
      this.logger.warn(
        `[InboundEmailResume] Orden duplicada de ${user.email}: la ejecucion ${execution.executionId} ya se esta reanudando; se ignora.`,
      );

      return false;
    }

    // Se espera SOLO el arranque: es lo que puede rechazar la orden (estado,
    // cursor, esquema, capacidad), y su excepcion sube como siempre. El
    // recorrido del motor no se espera; si se esperase, el barrido —global—
    // quedaria ocupado hasta que el flujo terminase.
    const { completion } = await this.executionsService.startResumeExecution(
      execution.executionId,
      targetStepId === null ? {} : { targetStepId },
      user,
      { isEmailResume: true },
    );

    this.trackBackgroundResume(execution.executionId, completion);

    this.logger.log(
      `[InboundEmailResume] Ejecucion ${execution.executionId} reanudada por ${user.email}${
        targetStepId === null ? '' : ` desde "${targetStepId}"`
      }`,
    );

    return true;
  }

  /**
   * Acompana el recorrido de una reanudacion lanzada sin esperarla.
   *
   * Registra el desenlace y libera la guarda de su ejecucion. El `catch` no es
   * opcional: una promesa rechazada sin manejador tumba el proceso de Node. El
   * motor ya deja su propia traza del fallo; aqui solo se dice que vino de una
   * orden por correo.
   */
  private trackBackgroundResume(
    executionId: string,
    completion: Promise<WorkflowExecutionResponseDto>,
  ): void {
    this.resumingExecutions.add(executionId);

    void completion
      .then((result) => {
        this.logger.log(
          `[InboundEmailResume] La ejecucion ${executionId} reanudada por correo termino en ${result.status}.`,
        );
      })
      .catch((error: unknown) => {
        // Un 409 aqui es el mutex POR FLUJO (RNF-09): otra ejecucion del mismo
        // flujo esta EN_PROCESO. No es una averia; la ejecucion sigue PAUSADO
        // y la orden se puede repetir cuando aquella termine.
        const message = `[InboundEmailResume] La reanudacion por correo de ${executionId} no pudo completarse: ${this.describe(error)}`;

        if (error instanceof ConflictException) {
          this.logger.warn(message);
        } else {
          this.logger.error(message);
        }
      })
      .finally(() => {
        this.resumingExecutions.delete(executionId);
      });
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

    const match = candidates.reduce<ReturnType<typeof parseResumeCommand>>(
      (found, candidate) =>
        found ??
        (candidate === null || candidate.length === 0
          ? null
          : parseResumeCommand(candidate)),
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
      token: match.token,
      targetIdentifier: match.targetIdentifier,
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

  /**
   * Identificador del usuario ACTIVO cuyo correo es `fromAddress`, o `null`.
   *
   * Lo usa `TRIGGER_IMAP` para imputar la ejecucion al remitente (migracion
   * 060). No exige rol: atribuir no es autorizar, y el correo ya entro por el
   * buzon del flujo. Nunca lanza: un fallo de lectura deja la ejecucion en la
   * cuenta de respaldo en vez de romper el disparo.
   */
  public async resolveSenderUserId(
    fromAddress: string,
  ): Promise<string | null> {
    if (fromAddress.trim() === '') {
      return null;
    }

    try {
      const user = await this.usersService.findByEmail(fromAddress);

      return user !== null && user.isActive ? user.id : null;
    } catch (error: unknown) {
      this.logger.warn(
        `[InboundEmailResume] No se pudo resolver el remitente ${fromAddress}: ${this.describe(error)}`,
      );

      return null;
    }
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
   * Diccionario `codigo` → `nombre` del catalogo de nodos.
   *
   * Se consulta en cada resolucion y NO se memoriza en un campo: la tabla
   * `nodos` son doce filas de datos de instalacion, y esta ruta se recorre
   * como mucho una vez por orden de correo. Una cache aqui solo anadiria la
   * pregunta de cuando invalidarla.
   *
   * Un fallo de lectura NO tumba la reanudacion: se devuelve un diccionario
   * vacio y la resolucion sigue con los tres alias que salen del propio
   * esquema. Perder la forma comoda de nombrar un paso es un inconveniente;
   * dejar sin reanudar un flujo detenido porque el catalogo no respondio seria
   * el fallo de verdad.
   */
  private async loadCatalogLabels(): Promise<ReadonlyMap<string, string>> {
    try {
      const entries = await this.nodeCatalogRepository.find();

      return new Map(entries.map((entry) => [entry.code, entry.name]));
    } catch (error: unknown) {
      this.logger.warn(
        `[InboundEmailResume] No se pudo leer el catalogo de nodos: ${this.describe(error)}. Se resuelve el paso solo por identificador, tipo o namespace.`,
      );

      return new Map();
    }
  }

  /**
   * Decide desde que paso se reanuda: el que pidio el operador, corregido por
   * la guarda anti-bucle del escudo. `null` significa "desde el cursor".
   */
  private async resolveTargetStep(
    execution: FsmExecution,
    identifier: string | null,
  ): Promise<string | null> {
    const workflow = await this.workflowRepository.findOne({
      where: { id: execution.flowId },
    });
    const nodes = (
      workflow?.pipelineSchema as
        { nodes?: Record<string, SchemaNode> } | null | undefined
    )?.nodes;

    if (nodes === undefined) {
      return null;
    }

    const requested =
      identifier === null
        ? null
        : await this.matchStepIdentifier(execution, nodes, identifier);

    return this.avoidShieldLoop(execution, nodes, requested);
  }

  /**
   * Traduce lo que el operador escribio tras "DESDE" a un `nodeId`.
   *
   * Prioridad: 1) etiqueta visible (`label` del esquema o la del catalogo
   * `nodos`), 2) identificador o namespace, 3) `nodeType`, 4) diccionario
   * `STEP_ALIASES`, todos comparados por `normalizeStepKey`; y 5) bolsa de
   * palabras (`tokenizeStepWords`): todas las palabras pedidas, en cualquier
   * orden, entre las de identificador, etiqueta, namespace y tipo del nodo.
   *
   * Con dos nodos del mismo tipo gana el primero declarado y queda traza.
   */
  private async matchStepIdentifier(
    execution: FsmExecution,
    nodes: Readonly<Record<string, SchemaNode>>,
    identifier: string,
  ): Promise<string | null> {
    const wanted = normalizeStepKey(identifier);
    const labelsByCode = await this.loadCatalogLabels();
    const entries = Object.entries(nodes).map(([nodeId, node]) => {
      const nodeType = typeof node.nodeType === 'string' ? node.nodeType : '';
      const label = typeof node.label === 'string' ? node.label : '';

      return {
        nodeId,
        nodeType,
        label: label.length > 0 ? label : (labelsByCode.get(nodeType) ?? ''),
        namespace:
          typeof node.outputNamespace === 'string' ? node.outputNamespace : '',
      };
    });
    const aliasType = STEP_ALIASES[wanted] ?? null;
    const sameKey = (value: string): boolean =>
      value.length > 0 && normalizeStepKey(value) === wanted;
    const queryTokens = tokenizeStepWords(identifier);
    const wordsOf = (entry: (typeof entries)[number]): ReadonlySet<string> =>
      new Set(
        [entry.nodeId, entry.label, entry.namespace, entry.nodeType].flatMap(
          tokenizeStepWords,
        ),
      );

    // Prioridad SECUENCIAL: gana el primer nivel con alguna coincidencia, de
    // modo que una etiqueta real nunca la pisa un sinonimo generico.
    //
    // La bolsa de palabras va la ULTIMA a proposito: es el nivel mas laxo. Un
    // «DESDE ia» casaria por palabras tambien con `escudo_post_ia`; puesto
    // detras del diccionario, ese caso lo resuelve antes el sinonimo exacto y
    // la bolsa solo atiende lo que ningun nivel estricto entiende, como el
    // orden invertido («plantilla mapeador»).
    const levels: readonly ((entry: (typeof entries)[number]) => boolean)[] = [
      (entry) => sameKey(entry.label),
      (entry) => sameKey(entry.nodeId) || sameKey(entry.namespace),
      (entry) => sameKey(entry.nodeType),
      (entry) => aliasType !== null && entry.nodeType === aliasType,
      (entry) => matchesStepWords(queryTokens, wordsOf(entry)),
    ];

    for (const matches of levels) {
      const found = entries.filter(matches).map((entry) => entry.nodeId);
      const [resolved, ...ambiguous] = found;

      if (resolved === undefined) {
        continue;
      }

      if (ambiguous.length > 0) {
        this.logger.warn(
          `[InboundEmailResume] El paso "${identifier}" nombra a varios nodos del flujo ${execution.flowId} (${found.join(', ')}): se reanuda desde el primero, "${resolved}".`,
        );
      }

      return resolved;
    }

    this.logger.warn(
      `[InboundEmailResume] El paso "${identifier}" no existe en el flujo ${execution.flowId}: se reanuda desde donde se detuvo.`,
    );

    return null;
  }

  /**
   * Guarda contra el bucle del escudo.
   *
   * Un `ESCUDO_POST_IA` es determinista: si rechazo una respuesta de la IA,
   * volver a ejecutarlo sobre esa MISMA respuesta —que sigue en el contexto—
   * falla otra vez al instante y deja el flujo pausado en bucle. Por eso, si el
   * paso efectivo (el pedido o, sin el, el cursor) es un escudo cuyo ultimo
   * desenlace fue un fallo regenerable, se reanuda desde su productor para que
   * la IA genere una respuesta nueva.
   *
   * Se aplica TAMBIEN a un «DESDE escudo» explicito: el operador pide repetir
   * la validacion, pero lo que necesita es otra respuesta que validar.
   *
   * Nunca impide la reanudacion: sin productor localizable o sin traza legible
   * se deja el paso como estaba, con un aviso.
   */
  private async avoidShieldLoop(
    execution: FsmExecution,
    nodes: Readonly<Record<string, SchemaNode>>,
    requested: string | null,
  ): Promise<string | null> {
    const effective = requested ?? execution.activeCursor;

    if (
      effective === null ||
      nodes[effective]?.nodeType !== NodeType.ESCUDO_POST_IA
    ) {
      return requested;
    }

    let lastCode: string | null;

    try {
      lastCode = await this.alertQueryService.findLastNodeErrorCode(
        execution.executionId,
        effective,
      );
    } catch (error: unknown) {
      this.logger.warn(
        `[InboundEmailResume] No se pudo leer la traza del escudo "${effective}": ${this.describe(error)}. Se reanuda desde el paso pedido.`,
      );

      return requested;
    }

    if (!isRegenerablePostIaError(lastCode)) {
      return requested;
    }

    const producer = findShieldProducer(nodes, effective);

    if (producer === null) {
      this.logger.warn(
        `[InboundEmailResume] El escudo "${effective}" fallo con ${lastCode}, pero no se encontro el nodo que produce su entrada en el flujo ${execution.flowId}: se reanuda desde el escudo.`,
      );

      return requested;
    }

    this.logger.warn(
      `[InboundEmailResume] El escudo "${effective}" fallo con ${lastCode}: reanudarlo sobre la misma respuesta volveria a fallar. Se reanuda desde "${producer}" para regenerarla.`,
    );

    return producer;
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
      subjectKeywords: [],
      subjectMatchMode: SubjectMatchMode.AL_MENOS_UNA,
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

  /** Libera el lock del buzon sin dejar que su fallo tape el error original. */
  private releaseQuietly(lock: MailboxLockObject | undefined): void {
    if (lock === undefined) {
      return;
    }

    try {
      lock.release();
    } catch (error: unknown) {
      this.logger.warn(
        `[InboundEmailResume] No se pudo liberar el buzon de ordenes: ${this.describe(error)}`,
      );
    }
  }

  /**
   * Cierra la sesion sin dejar que un fallo de salida tape el resultado.
   *
   * Delega en `closeImapClientQuietly`: la version propia solo destruia el
   * socket cuando `logout()` lanzaba, de modo que el camino normal —el que
   * corre en cada ciclo— dejaba el cliente a merced del recolector con sus
   * oyentes todavia enganchados.
   */
  private async logoutQuietly(client: ImapFlow): Promise<void> {
    await closeImapClientQuietly(client, (error: unknown) => {
      this.logger.warn(
        `[InboundEmailResume] No se pudo cerrar la sesion del buzon de ordenes: ${this.describe(error)}`,
      );
    });
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : 'causa desconocida';
  }
}
