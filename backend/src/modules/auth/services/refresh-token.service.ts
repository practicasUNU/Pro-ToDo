import { createHash, randomBytes } from 'node:crypto';

import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';

import { RefreshToken } from '@modules/auth/entities/refresh-token.entity';

import type { User } from '@modules/users/entities/user.entity';

/** Entropia del token opaco: 32 bytes = 256 bits, inadivinable por fuerza bruta. */
const TOKEN_BYTES = 32;

/** Vigencia por defecto si `REFRESH_TOKEN_EXPIRES_IN_DAYS` no esta definida. */
const DEFAULT_EXPIRATION_DAYS = 7;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Mensaje unico para todos los modos de fallo de la renovacion.
 *
 * Un token inexistente, uno caducado y uno ya canjeado devuelven exactamente lo
 * mismo: el cliente no debe poder distinguir en que estado se encuentra su
 * credencial, porque esa diferencia es informacion util para un atacante.
 */
const INVALID_REFRESH_MESSAGE = 'Sesion invalida o expirada.';

/**
 * Emision, rotacion y revocacion de refresh tokens (PROT-06.4).
 *
 * Unico punto del backend que conoce la tabla `refresh_tokens`. No sabe de HTTP
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
   * Emite un token nuevo para el usuario y persiste unicamente su hash.
   *
   * @returns El token EN CLARO. Es la unica vez que existe fuera del cliente:
   *          no se registra en logs ni se puede recuperar despues.
   */
  public async issue(user: User): Promise<string> {
    const rawToken = randomBytes(TOKEN_BYTES).toString('base64url');

    await this.refreshTokenRepository.save(
      this.refreshTokenRepository.create({
        userId: user.id,
        tokenHash: this.hashToken(rawToken),
        expiresAt: new Date(Date.now() + this.getExpirationMs()),
        isRevoked: false,
      }),
    );

    return rawToken;
  }

  /**
   * Canjea un token por su dueño y lo invalida en el mismo acto (rotacion).
   *
   * Quien llama es responsable de emitir el reemplazo con `issue()`.
   *
   * @throws UnauthorizedException si el token no existe, ya fue canjeado, ha
   *         caducado, o su dueño no existe o esta desactivado.
   */
  public async rotate(rawToken: string): Promise<User> {
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

    return stored.user;
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

  /** Elimina los tokens ya caducados. Sin uso automatico todavia (ver Walkthrough). */
  public async purgeExpired(): Promise<void> {
    await this.refreshTokenRepository.delete({
      expiresAt: LessThan(new Date()),
    });
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

  /** Vigencia en milisegundos, derivada de `REFRESH_TOKEN_EXPIRES_IN_DAYS`. */
  private getExpirationMs(): number {
    const days =
      this.configService.get<number>('REFRESH_TOKEN_EXPIRES_IN_DAYS') ??
      DEFAULT_EXPIRATION_DAYS;

    return Number(days) * MILLISECONDS_PER_DAY;
  }
}
