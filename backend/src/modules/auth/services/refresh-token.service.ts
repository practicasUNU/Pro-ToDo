import { createHash, randomBytes } from 'node:crypto';

import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, MoreThan, Repository } from 'typeorm';

import { RefreshToken } from '@modules/auth/entities/refresh-token.entity';

import type { User } from '@modules/users/entities/user.entity';

/** Entropia del token opaco: 32 bytes = 256 bits, inadivinable por fuerza bruta. */
const TOKEN_BYTES = 32;

/** Vigencia por defecto si `REFRESH_TOKEN_EXPIRES_IN_DAYS` no esta definida. */
const DEFAULT_EXPIRATION_DAYS = 7;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Tokens ya inservibles que se conservan por usuario tras cada emision.
 *
 * No es un numero arbitrario: son la ventana de deteccion de reutilizacion de
 * `rotate()`. Un token robado que reaparezca dentro de estas ultimas rotaciones
 * todavia encuentra su fila y derriba la familia entera; sin ella degeneraria en
 * un 401 plano y la brecha pasaria desapercibida.
 */
const RETAINED_DEAD_TOKENS = 5;

/**
 * Sesiones vivas simultaneas que se permiten por usuario (MOD-01).
 *
 * OJO: coincide en valor con `RETAINED_DEAD_TOKENS` y no tiene NADA que ver.
 * Aquella cuenta tokens ya inservibles que se conservan como rastro; esta acota
 * cuantos dispositivos pueden tener sesion abierta a la vez. Cambiar una no
 * implica cambiar la otra.
 *
 * Como `issue()` revoca antes el token previo del mismo dispositivo, no puede
 * haber dos filas vivas para un mismo `deviceId`: contar tokens activos es, por
 * tanto, contar dispositivos.
 */
const MAX_ACTIVE_SESSIONS = 5;

/**
 * Mensaje unico para todos los modos de fallo de la renovacion.
 *
 * Un token inexistente, uno caducado y uno ya canjeado devuelven exactamente lo
 * mismo: el cliente no debe poder distinguir en que estado se encuentra su
 * credencial, porque esa diferencia es informacion util para un atacante.
 */
const INVALID_REFRESH_MESSAGE = 'Sesion invalida o expirada.';

/**
 * Usuario y dispositivo del token canjeado, para emitir el reemplazo.
 *
 * El `deviceId` viaja de vuelta a proposito: el dispositivo se fija en el login y
 * lo transporta la cadena de tokens, asi que el cliente no lo reenvia al renovar.
 * Un token en rotacion no debe poder cambiar de dispositivo a mitad de sesion.
 */
export interface RotatedSession {
  user: User;
  deviceId: string;
}

/**
 * Emision, rotacion y revocacion de refresh tokens (PROT-06.4).
 *
 * Unico punto del backend que conoce la tabla `tokens_sesion`. No sabe de HTTP
 * ni de JWT: entrega y valida credenciales opacas; firmar el access token es
 * cosa de `AuthService`.
 */
@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);

  constructor(
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Emite un token nuevo para el dispositivo indicado y persiste solo su hash.
   *
   * Aisla las sesiones por dispositivo: la sesion anterior de ESE dispositivo
   * queda revocada, y las de los demas equipos del usuario siguen intactas.
   *
   * @returns El token EN CLARO. Es la unica vez que existe fuera del cliente:
   *          no se registra en logs ni se puede recuperar despues.
   */
  public async issue(user: User, deviceId: string): Promise<string> {
    const rawToken = randomBytes(TOKEN_BYTES).toString('base64url');

    // Los tres pasos comparten transaccion: si alguno falla, el token nuevo
    // tampoco se persiste. Nunca se revoca ni se borra nada sin que su reemplazo
    // exista. Por eso la revocacion usa el repositorio TRANSACCIONAL y no
    // `this.refreshTokenRepository`, que quedaria fuera de la transaccion y
    // dejaria al usuario sin sesion en este dispositivo si la insercion fallara.
    await this.refreshTokenRepository.manager.transaction(async (manager) => {
      const repository = manager.getRepository(RefreshToken);

      // Una sesion nueva en un dispositivo sustituye a la anterior de ese mismo
      // dispositivo. Va ANTES de insertar a proposito: despues, el filtro
      // `isRevoked: false` alcanzaria al token recien creado y lo revocaria al nacer.
      await repository.update(
        { userId: user.id, deviceId, isRevoked: false },
        { isRevoked: true },
      );

      await repository.save(
        repository.create({
          userId: user.id,
          deviceId,
          tokenHash: this.hashToken(rawToken),
          expiresAt: new Date(Date.now() + this.getExpirationMs()),
          isRevoked: false,
        }),
      );

      // Despues del `save` a proposito, igual que la poda: el token recien
      // insertado es el mas reciente, asi que nunca cae en la cola del `skip` y
      // no puede expulsarse a si mismo.
      await this.enforceSessionLimit(repository, user.id);

      await this.pruneDeadTokens(repository, user.id);
    });

    return rawToken;
  }

  /**
   * Canjea un token por su dueño y lo invalida en el mismo acto (rotacion).
   *
   * Quien llama es responsable de emitir el reemplazo con `issue()`, para lo que
   * necesita tambien el dispositivo: de ahi que se devuelva `RotatedSession` y no
   * solo el usuario.
   *
   * @throws UnauthorizedException si el token no existe, ya fue canjeado, ha
   *         caducado, o su dueño no existe o esta desactivado.
   */
  public async rotate(rawToken: string): Promise<RotatedSession> {
    const stored = await this.refreshTokenRepository.findOne({
      where: { tokenHash: this.hashToken(rawToken) },
      relations: { user: true },
    });

    if (!stored) {
      throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
    }

    // Reutilizacion: un token valido solo se presenta una vez. Que reaparezca ya
    // revocado significa que alguien conserva una copia, asi que se derriba la
    // familia entera y se obliga a un login nuevo por OTP.
    if (stored.isRevoked) {
      this.logger.warn(
        `Reutilizacion de refresh token detectada para el usuario ${stored.userId}: se revocan todas sus sesiones.`,
      );
      await this.revokeAllForUser(stored.userId);

      throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
    }

    // Una cuenta dada de baja no puede prolongar su sesion con un token que
    // seguia vivo desde antes de la desactivacion.
    if (!stored.user?.isActive) {
      throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
    }

    await this.refreshTokenRepository.update(
      { id: stored.id },
      { isRevoked: true },
    );

    return { user: stored.user, deviceId: stored.deviceId };
  }

  /**
   * Revoca un token concreto (cierre de sesion voluntario).
   *
   * Silencioso a proposito: si el token ya no existe o ya estaba revocado, el
   * cierre de sesion se considera igualmente cumplido.
   */
  public async revoke(rawToken: string): Promise<void> {
    await this.refreshTokenRepository.update(
      { tokenHash: this.hashToken(rawToken) },
      { isRevoked: true },
    );
  }

  /** Revoca todas las sesiones vivas de un usuario. */
  public async revokeAllForUser(userId: string): Promise<void> {
    await this.refreshTokenRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true },
    );
  }

  /**
   * Expulsa las sesiones que exceden `MAX_ACTIVE_SESSIONS`, de la mas antigua.
   *
   * Las sobrantes se BORRAN, nunca se revocan, y la diferencia es de seguridad,
   * no de estilo. Una fila revocada sigue existiendo, asi que cuando el
   * dispositivo expulsado presentase su token, `rotate()` lo encontraria con
   * `isRevoked: true` y lo interpretaria como REUTILIZACION: derribaria con
   * `revokeAllForUser()` las demas sesiones del usuario y registraria una alerta
   * de robo falsa. Al borrarla, ese mismo intento no encuentra fila y termina en
   * el 401 corriente, con el mensaje opaco de siempre y sin dañar a nadie mas.
   *
   * Solo cuentan las sesiones REALMENTE vivas: una fila revocada o caducada ya no
   * ocupa plaza, y de esas se encarga `pruneDeadTokens`.
   */
  private async enforceSessionLimit(
    repository: Repository<RefreshToken>,
    userId: string,
  ): Promise<void> {
    const evictedSessions = await repository.find({
      where: { userId, isRevoked: false, expiresAt: MoreThan(new Date()) },
      // El desempate por `id` hace determinista el orden: dos tokens emitidos en
      // el mismo instante compartirian `createdAt` y el corte del `skip` quedaria
      // a merced del plan de ejecucion.
      order: { createdAt: 'DESC', id: 'DESC' },
      select: { id: true },
      skip: MAX_ACTIVE_SESSIONS,
    });

    if (evictedSessions.length === 0) return;

    await repository.delete(evictedSessions.map(({ id }) => id));
  }

  /**
   * Borra los tokens ya inservibles del usuario, conservando los mas recientes.
   *
   * Un token VIGENTE no entra jamas en el filtro, por antiguo que sea: son las
   * sesiones abiertas en otros dispositivos, y podarlas por antiguedad expulsaria
   * al usuario sin aviso —el refresco rutinario de un equipo cerraria la sesion
   * del otro—. Solo se elimina lo que ya no puede canjearse.
   *
   * El token recien insertado tampoco es candidato: nace sin revocar y con
   * expiracion futura. De ahi el orden insertar -> podar.
   */
  private async pruneDeadTokens(
    repository: Repository<RefreshToken>,
    userId: string,
  ): Promise<void> {
    // El `where` en forma de array es un OR: revocado O caducado.
    const doomedTokens = await repository.find({
      where: [
        { userId, isRevoked: true },
        { userId, expiresAt: LessThanOrEqual(new Date()) },
      ],
      order: { createdAt: 'DESC' },
      select: { id: true },
      skip: RETAINED_DEAD_TOKENS,
    });

    if (doomedTokens.length === 0) return;

    await repository.delete(doomedTokens.map(({ id }) => id));
  }

  /**
   * SHA-256 hexadecimal del token.
   *
   * No lleva sal ni derivacion lenta a proposito: el valor de entrada ya son 256
   * bits aleatorios, asi que no hay diccionario que precomputar. La sal solo
   * aporta frente a secretos de baja entropia, que no es el caso.
   */
  private hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  /**
   * Vigencia en milisegundos, derivada de `REFRESH_TOKEN_EXPIRES_IN_DAYS`.
   *
   * La coalescencia nula por si sola NO basta: solo cubre la variable ausente,
   * y del `.env` llega siempre una cadena. Una vacia daria `Number('') === 0` y
   * cada token naceria ya caducado —el login quedaria roto sin un solo error en
   * el log—; una no numerica daria `NaN` y con el una fecha invalida. De ahi que
   * se valide el numero resultante y no la mera presencia de la variable.
   */
  private getExpirationMs(): number {
    const configuredDays = Number(
      this.configService.get<string>('REFRESH_TOKEN_EXPIRES_IN_DAYS'),
    );

    const days =
      Number.isFinite(configuredDays) && configuredDays > 0
        ? configuredDays
        : DEFAULT_EXPIRATION_DAYS;

    return days * MILLISECONDS_PER_DAY;
  }
}
