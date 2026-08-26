import { createHmac } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NobleCryptoPlugin, ScureBase32Plugin, TOTP } from 'otplib';

/** Digitos del codigo, fijados por la especificacion funcional. */
const OTP_DIGITS = 6;

/**
 * Paso temporal del TOTP en segundos. Se mantiene fino (1 minuto) y la vigencia
 * real se consigue con la tolerancia hacia el pasado, de modo que el codigo dure
 * `OTP_EXPIRATION_MINUTES` completos y no lo que reste de una ventana larga.
 */
const OTP_PERIOD_SECONDS = 60;

/** Vigencia por defecto si `OTP_EXPIRATION_MINUTES` no esta definida. */
const DEFAULT_EXPIRATION_MINUTES = 5;

const SECONDS_PER_MINUTE = 60;

/**
 * Generacion y verificacion criptografica de codigos temporales (PROT-04.1).
 *
 * Unico punto del backend que conoce `otplib`. No sabe de HTTP, de correo ni de
 * usuarios: recibe un correo, deriva su secreto y opera sobre el.
 */
@Injectable()
export class OtpConfigService {
  private readonly totp: TOTP;

  constructor(private readonly configService: ConfigService) {
    // otplib v13 es modular: hay que inyectar explicitamente los plugins de
    // criptografia y de codificacion base32 (la API `authenticator` de la v12 ya no existe).
    this.totp = new TOTP({
      crypto: new NobleCryptoPlugin(),
      base32: new ScureBase32Plugin(),
      digits: OTP_DIGITS,
      period: OTP_PERIOD_SECONDS,
    });
  }

  /** Genera el codigo de 6 digitos vigente para ese correo. */
  public async generateCode(email: string): Promise<string> {
    return this.totp.generate({ secret: this.deriveUserSecret(email) });
  }

  /**
   * Verifica el codigo contra el secreto derivado del correo, aceptando cualquier
   * paso temporal dentro de la ventana de expiracion (solo hacia el pasado: un
   * codigo del futuro nunca es valido).
   */
  public async verifyCode(email: string, code: string): Promise<boolean> {
    const result = await this.totp.verify(code, {
      secret: this.deriveUserSecret(email),
      epochTolerance: [this.getExpirationSeconds(), 0],
    });

    return result.valid;
  }

  /**
   * Deriva un secreto TOTP propio de cada usuario a partir de la semilla maestra.
   *
   * Es imprescindible: con un `OTP_SECRET` compartido, el mismo codigo de 6 digitos
   * seria valido para TODAS las cuentas en la misma ventana temporal, y cualquiera
   * podria pedir su propio codigo para entrar como otro. Al ser determinista, no
   * hace falta persistir el secreto en base de datos.
   */
  private deriveUserSecret(email: string): string {
    const masterSecret = this.configService.get<string>('OTP_SECRET');

    if (!masterSecret) {
      throw new Error(
        'OTP_SECRET no esta definida: no se pueden emitir codigos temporales.',
      );
    }

    const digest = createHmac('sha256', masterSecret)
      .update(email.trim().toLowerCase())
      .digest();

    return new ScureBase32Plugin().encode(new Uint8Array(digest));
  }

  /** Ventana de validez en segundos, derivada de `OTP_EXPIRATION_MINUTES`. */
  private getExpirationSeconds(): number {
    const minutes =
      this.configService.get<number>('OTP_EXPIRATION_MINUTES') ??
      DEFAULT_EXPIRATION_MINUTES;

    return Number(minutes) * SECONDS_PER_MINUTE;
  }
}
