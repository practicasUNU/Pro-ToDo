import { randomBytes } from 'node:crypto';

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

/** 20 bytes = 160 bits, el tamaño de clave que recomienda la RFC 4226 para HOTP/TOTP. */
const SECRET_BYTES = 20;

/**
 * Generacion y verificacion criptografica de codigos temporales (PROT-04.1).
 *
 * Unico punto del backend que conoce `otplib`. Opera sobre un secreto que recibe
 * como argumento: no sabe de HTTP, de correo, de usuarios ni de base de datos.
 * Quien custodia el secreto es `UsersService`.
 */
@Injectable()
export class OtpConfigService {
  private readonly totp: TOTP;
  private readonly base32 = new ScureBase32Plugin();

  constructor(private readonly configService: ConfigService) {
    // otplib v13 es modular: hay que inyectar explicitamente los plugins de
    // criptografia y de codificacion base32 (la API `authenticator` de la v12 ya no existe).
    this.totp = new TOTP({
      crypto: new NobleCryptoPlugin(),
      base32: this.base32,
      digits: OTP_DIGITS,
      period: OTP_PERIOD_SECONDS,
    });
  }

  /**
   * Crea un secreto TOTP nuevo en base32 (32 caracteres, sin relleno).
   *
   * Aleatorio y por cuenta, no derivado de una semilla maestra: rotar o revocar
   * la inscripcion de un usuario no afecta a la de nadie mas.
   */
  public generateSecret(): string {
    return this.base32.encode(new Uint8Array(randomBytes(SECRET_BYTES)));
  }

  /** Genera el codigo de 6 digitos vigente para ese secreto. */
  public async generateCode(secret: string): Promise<string> {
    return this.totp.generate({ secret });
  }

  /**
   * Verifica el codigo contra el secreto, aceptando cualquier paso temporal
   * dentro de la ventana de expiracion (solo hacia el pasado: un codigo del
   * futuro nunca es valido).
   */
  public async verifyCode(secret: string, code: string): Promise<boolean> {
    const result = await this.totp.verify(code, {
      secret,
      epochTolerance: [this.getExpirationSeconds(), 0],
    });

    return result.valid;
  }

  /**
   * Ventana de validez en segundos, derivada de `OTP_EXPIRATION_MINUTES`.
   *
   * Es publica porque el controlador la devuelve al cliente: es un parametro de
   * configuracion global, igual para toda cuenta, asi que exponerla no permite
   * enumerar usuarios ni deducir nada del codigo emitido.
   */
  public getExpirationSeconds(): number {
    const minutes =
      this.configService.get<number>('OTP_EXPIRATION_MINUTES') ??
      DEFAULT_EXPIRATION_MINUTES;

    return Number(minutes) * SECONDS_PER_MINUTE;
  }
}
