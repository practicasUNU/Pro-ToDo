import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Variable de entorno con la clave maestra, 32 bytes en base64. */
export const CREDENTIALS_ENCRYPTION_KEY_VAR = 'CREDENTIALS_ENCRYPTION_KEY';

/** Algoritmo de cifrado autenticado. */
const ALGORITHM = 'aes-256-gcm';

/** Longitud exigida de la clave: AES-256 son 32 bytes, ni uno mas ni uno menos. */
export const ENCRYPTION_KEY_BYTES = 32;

/**
 * Longitud del vector de inicializacion: 12 bytes es el tamano NATIVO de GCM.
 * Cualquier otro obliga al algoritmo a derivarlo con GHASH y no aporta nada.
 */
const IV_BYTES = 12;

/** Longitud de la etiqueta de autenticacion: el maximo de GCM. */
const AUTH_TAG_BYTES = 16;

/** Texto cifrado y sus dos piezas de verificacion, en base64. */
export interface EncryptedPayload {
  readonly ciphertext: string;
  readonly iv: string;
  readonly authTag: string;
}

/**
 * Cifrado simetrico AES-256-GCM de secretos en reposo, reutilizable.
 *
 * GCM y no CBC porque es CIFRADO AUTENTICADO: una fila alterada en la base de
 * datos —un bit cambiado en `datos_cifrados`, un IV de otra fila— no descifra a
 * basura que el codigo intentaria usar, sino que `decrypt` lanza. Para una
 * credencial, «no descifra» es mucho mejor desenlace que «descifra a otra cosa».
 *
 * EL `aad` ES OBLIGATORIO. Quien cifra pasa un dato asociado que no se cifra
 * pero si se autentica —para las credenciales, su propio `id_credencial`—, de
 * modo que copiar el blob de una fila a otra lo vuelve indescifrable. Sin el,
 * un acceso de escritura a la tabla bastaria para intercambiar el token de
 * produccion por el de pruebas sin tocar la clave.
 *
 * NO LANZA AL ARRANCAR, igual que `DrupalApiConfig`: sin clave, `isUsable` es
 * falso y la boveda devuelve 503, pero el resto del backend funciona. Una
 * clave mal formada (longitud distinta de 32 bytes) cuenta como ausente y deja
 * un aviso con el motivo, nunca con el valor.
 */
@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);

  constructor(private readonly configService: ConfigService) {}

  /** Hay una clave valida con la que cifrar y descifrar. */
  public get isUsable(): boolean {
    return this.readKey() !== null;
  }

  /**
   * Cifra `plaintext` ligandolo a `aad`.
   *
   * El IV es aleatorio en CADA llamada: reutilizar un IV con la misma clave en
   * GCM permite recuperar el flujo de cifrado, que es el unico error de uso de
   * este algoritmo que no perdona.
   *
   * @throws Error Si no hay una clave utilizable. Quien llama comprueba
   *         `isUsable` antes; llegar aqui sin clave es un fallo de programacion.
   */
  public encrypt(plaintext: string, aad: string): EncryptedPayload {
    const key = this.requireKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });

    cipher.setAAD(Buffer.from(aad, 'utf8'));

    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    };
  }

  /**
   * Descifra y AUTENTICA un payload producido por `encrypt`.
   *
   * @throws Error Si la clave falta, si la etiqueta no coincide (dato alterado,
   *         clave distinta o `aad` de otra fila). El mensaje nunca incluye el
   *         contenido.
   */
  public decrypt(payload: EncryptedPayload, aad: string): string {
    const key = this.requireKey();
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(payload.iv, 'base64'),
      { authTagLength: AUTH_TAG_BYTES },
    );

    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));

    return Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  private requireKey(): Buffer {
    const key = this.readKey();

    if (key === null) {
      throw new Error(
        `${CREDENTIALS_ENCRYPTION_KEY_VAR} no esta definida o no mide ${ENCRYPTION_KEY_BYTES} bytes en base64.`,
      );
    }

    return key;
  }

  /**
   * Clave decodificada, o `null` si falta o esta mal formada.
   *
   * Se relee en cada uso en vez de cachearse: `ConfigService` ya la tiene en
   * memoria, y no cachear evita que un buffer con la clave quede vivo en un
   * campo de la instancia mas tiempo del necesario.
   */
  private readKey(): Buffer | null {
    const raw = this.configService
      .get<string>(CREDENTIALS_ENCRYPTION_KEY_VAR)
      ?.trim();

    if (raw === undefined || raw.length === 0) {
      return null;
    }

    const key = Buffer.from(raw, 'base64');

    if (key.length !== ENCRYPTION_KEY_BYTES) {
      this.logger.warn(
        `${CREDENTIALS_ENCRYPTION_KEY_VAR} decodifica a ${key.length} bytes y se exigen ${ENCRYPTION_KEY_BYTES}. Generala con: openssl rand -base64 32`,
      );

      return null;
    }

    return key;
  }
}
