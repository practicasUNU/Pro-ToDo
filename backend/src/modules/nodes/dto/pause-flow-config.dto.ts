import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Momento en que el nodo congela el flujo.
 *
 * NO es una politica de reanudacion: de PAUSADO solo se sale por CU-09, con un
 * operador delante. Lo que elige este enum es CUANDO entra la pausa una vez que
 * el paso anterior ha concluido.
 */
export enum PauseTriggerMode {
  /** Congela en cuanto el motor alcanza el nodo. */
  IMMEDIATE = 'IMMEDIATE',
  /** Espera `delaySeconds` antes de congelar. */
  DELAYED = 'DELAYED',
}

/**
 * Tope del retardo, en segundos.
 *
 * Quince minutos, y el limite no es arbitrario: la espera transcurre DENTRO de
 * `execute`, con la ejecucion en EN_PROCESO ocupando una plaza de la capacidad
 * global y reteniendo el mutex parcial `idx_flujo_activo` del flujo. Un retardo
 * de horas convertiria un nodo de control en una fuga de capacidad, y un
 * reinicio del proceso a mitad de la espera dejaria la fila EN_PROCESO sin
 * checkpoint posterior.
 *
 * Quien necesite detener un flujo durante horas tiene la herramienta correcta a
 * mano: dar de baja el flujo, que no consume nada mientras espera.
 */
export const MAX_PAUSE_DELAY_SECONDS = 900;

/** Longitud maxima del mensaje que el operador deja explicando la pausa. */
export const MAX_PAUSE_MESSAGE_LENGTH = 500;

/** Texto que acompana a la pausa cuando el operador no escribe ninguno. */
export const DEFAULT_PAUSE_MESSAGE = 'Pausa programada de flujo';

/**
 * Configuracion del nodo `PAUSA_FLOW`.
 *
 * TODOS LOS CAMPOS SON OPCIONALES, incluido `pauseMode`, por el motivo de
 * siempre: una PLANTILLA de flujo es topologia sin operativa y sus `params` van
 * vacios a proposito, asi que un campo obligatorio aqui impediria que ninguna
 * plantilla contuviera este nodo. La pregunta "esta completo para ejecutarse"
 * vive en `getIncompleteParams`, que solo se consulta al ACTIVAR.
 *
 * NO HAY CAMPOS DE AUTO-REANUDACION, y su ausencia es una decision y no un
 * olvido. Una expresion Cron o una fecha de vuelta prometen que el flujo se
 * reanudara solo, y nada en el sistema lo haria: la unica salida de PAUSADO es
 * `POST /executions/:id/resume`, que exige un operador. Un campo que promete
 * algo que no ocurre es peor que no tener el campo.
 */
export class PauseFlowConfigDto {
  @ApiPropertyOptional({
    enum: PauseTriggerMode,
    description:
      'Cuando congelar el flujo: IMMEDIATE al alcanzar el nodo, DELAYED tras esperar delaySeconds. Por defecto IMMEDIATE.',
    example: PauseTriggerMode.IMMEDIATE,
  })
  @IsOptional()
  @IsEnum(PauseTriggerMode, {
    message: `pauseMode debe ser uno de: ${Object.values(PauseTriggerMode).join(', ')}.`,
  })
  pauseMode?: PauseTriggerMode;

  @ApiPropertyOptional({
    description:
      'Segundos de espera antes de congelar el flujo. Solo se aplica con pauseMode DELAYED.',
    example: 300,
    minimum: 1,
    maximum: MAX_PAUSE_DELAY_SECONDS,
  })
  @IsOptional()
  @IsInt({ message: 'delaySeconds debe ser un numero entero de segundos.' })
  @Min(1, { message: 'delaySeconds debe ser al menos 1 segundo.' })
  @Max(MAX_PAUSE_DELAY_SECONDS, {
    message: `delaySeconds no puede superar ${MAX_PAUSE_DELAY_SECONDS} segundos.`,
  })
  delaySeconds?: number;

  @ApiPropertyOptional({
    description:
      'Avisar por correo al entrar en pausa. Es un aviso informativo, no una alerta de error.',
    example: false,
  })
  @IsOptional()
  @IsBoolean({ message: 'notifyOnPause debe ser booleano.' })
  notifyOnPause?: boolean;

  @ApiPropertyOptional({
    description:
      'Destinatario del aviso de pausa. Obligatorio para ACTIVAR el flujo si notifyOnPause es true.',
    example: 'operaciones@unuware.com',
  })
  @IsOptional()
  @IsEmail({}, { message: 'notificationRecipient debe ser un correo valido.' })
  notificationRecipient?: string;

  @ApiPropertyOptional({
    description:
      'Explicacion de la pausa, en TEXTO PLANO. No se interpola: un {{...}} escrito aqui sale literal.',
    example: 'A la espera del visto bueno de redaccion.',
    maxLength: MAX_PAUSE_MESSAGE_LENGTH,
  })
  @IsOptional()
  @IsString({ message: 'customPauseMessage debe ser una cadena.' })
  @IsNotEmpty({ message: 'customPauseMessage no puede ir vacio.' })
  @MaxLength(MAX_PAUSE_MESSAGE_LENGTH, {
    message: `customPauseMessage no puede superar ${MAX_PAUSE_MESSAGE_LENGTH} caracteres.`,
  })
  customPauseMessage?: string;
}

/** Configuracion del nodo con los valores por defecto ya aplicados. */
export interface ResolvedPauseFlowConfig {
  readonly pauseMode: PauseTriggerMode;
  /** Segundos efectivos de espera. Cero cuando la pausa es inmediata. */
  readonly delaySeconds: number;
  readonly notifyOnPause: boolean;
  readonly notificationRecipient: string | null;
  readonly message: string;
}

/**
 * Aplica los valores por defecto sobre un DTO ya validado. Funcion pura.
 *
 * El retardo se NEUTRALIZA cuando el modo es inmediato, en vez de arrastrarse.
 * Asi un operador que configuro una espera y luego volvio a "Pausa inmediata"
 * no deja un `delaySeconds` huerfano que el nodo respetaria igualmente: lo que
 * manda es el modo, y el numero solo acompana.
 */
export const resolvePauseFlowConfig = (
  dto: PauseFlowConfigDto,
): ResolvedPauseFlowConfig => {
  const pauseMode = dto.pauseMode ?? PauseTriggerMode.IMMEDIATE;

  return {
    pauseMode,
    delaySeconds:
      pauseMode === PauseTriggerMode.DELAYED ? (dto.delaySeconds ?? 0) : 0,
    notifyOnPause: dto.notifyOnPause ?? false,
    notificationRecipient: dto.notificationRecipient ?? null,
    message: dto.customPauseMessage ?? DEFAULT_PAUSE_MESSAGE,
  };
};
