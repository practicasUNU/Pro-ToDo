import { createHash, randomBytes } from 'node:crypto';

/**
 * Testigo de un solo uso para reanudar una ejecucion detenida desde el correo.
 *
 * VIVE EN `@common` Y NO EN UNA ESTRATEGIA porque lo emiten DOS nodos distintos
 * —`PAUSA_FLOW` al anunciar una suspension deliberada y `DESTINO_SMTP` al
 * avisar de una pausa por fallo GRAVE— y lo verifica un tercero,
 * `InboundEmailResumeService`. Mientras el generador vivio dentro de
 * `pause-flow.strategy.ts`, el servicio de reanudacion importaba de una
 * estrategia concreta, que es una dependencia al reves de como corre el flujo.
 *
 * LO CRITICO ES QUE EL HASH SEA UNO SOLO. Una segunda implementacion que
 * normalizara distinto —sin el `trim`, sin el `toLowerCase`— produciria huellas
 * que no casan, y el sintoma seria un testigo legitimo rechazado como
 * "desconocido o caducado", sin nada en el registro que apuntara a la causa.
 */

/**
 * Vigencia del testigo. Siete dias.
 *
 * Una pausa que espera el visto bueno de una persona puede cruzar un fin de
 * semana o unas vacaciones cortas; menos tiempo obligaria a relanzar el flujo
 * por una demora normal. Mas tampoco: un testigo que vive en un buzon durante
 * meses es un testigo que alguien reenvia por error.
 */
export const RESUME_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Vigencia en dias, para los textos del aviso. */
export const RESUME_TOKEN_TTL_DAYS =
  RESUME_TOKEN_TTL_MS / (24 * 60 * 60 * 1000);

/**
 * Genera un testigo nuevo.
 *
 * Veinte caracteres hexadecimales: 80 bits, que es mucho mas de lo que hace
 * falta para que no se adivine, y a la vez algo que una persona puede copiar a
 * mano desde el aviso sin equivocarse. Sin simbolos, porque viaja por correo y
 * varios clientes reescriben el texto que no reconocen.
 *
 * Se mantienen los 10 bytes y no se baja a 4: esta credencial es PORTADORA y
 * entra desde Internet, saltandose a la vez el filtro por subred, el OTP y el
 * JWT. Ocho caracteres hexadecimales son 32 bits, que si se pueden recorrer.
 */
export const generateResumeToken = (): string =>
  randomBytes(10).toString('hex');

/**
 * Huella del testigo. Es lo UNICO que se persiste.
 *
 * El testigo viaja en claro en el correo y de el solo se guarda esto, igual que
 * con una contrasena: el contexto acumulado se devuelve por la API y acaba en
 * el checkpoint de cada transicion, asi que guardarlo entero seria repartir la
 * credencial por todas partes.
 */
export const hashResumeToken = (token: string): string =>
  createHash('sha256').update(token.trim().toLowerCase()).digest('hex');

/** Marca ISO-8601 de caducidad, contada desde ahora. */
export const buildResumeTokenExpiry = (): string =>
  new Date(Date.now() + RESUME_TOKEN_TTL_MS).toISOString();

/**
 * Instrucciones de reanudacion por correo, para el pie del aviso.
 *
 * Pide responder con el CUERPO y no con el asunto: los clientes anteponen `Re:`
 * al responder, de modo que un asunto que empiece exactamente por `REANUDAR`
 * solo se consigue editandolo a mano. `InboundEmailResumeService` sigue
 * aceptando las dos vias, pero lo que se le pide a la persona es la que
 * funciona sin que tenga que hacer nada especial.
 */
export const buildResumeInstructions = (token: string): string =>
  [
    'Para reanudar este flujo, responde a este correo escribiendo en el CUERPO,',
    'como primera linea y sin nada mas:',
    '',
    `REANUDAR ${token}`,
    '',
    'Para retomarlo desde un paso concreto, anade "DESDE <paso>".',
    `El codigo caduca en ${RESUME_TOKEN_TTL_DAYS} dias y sirve una sola vez.`,
  ].join('\n');
