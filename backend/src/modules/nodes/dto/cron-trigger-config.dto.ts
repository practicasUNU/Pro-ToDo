import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Validate,
  ValidatorConstraint,
} from 'class-validator';
import { validateCronExpression } from 'cron';

import { OUTPUT_NAMESPACE_PATTERN } from '@core/fsm/types/pipeline-schema.types';

import type {
  ValidationArguments,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * Zona horaria por defecto: la de la organizacion.
 *
 * No se usa UTC como default porque quien escribe `0 9 * * 1-5` en el asistente
 * quiere decir "a las nueve de la manana", y en UTC eso seria las diez en
 * invierno y las once en verano.
 */
export const DEFAULT_CRON_TIMEZONE = 'Europe/Madrid';

/**
 * Namespace por defecto bajo el que el nodo declara escribir su salida.
 *
 * A diferencia de TRIGGER_IMAP —que reutiliza `raw_email`— este nombre es nuevo,
 * asi que se ha dado de alta en `ALLOWED_NAMESPACES` (`templates.service.ts`) y
 * en su espejo `TEMPLATE_NAMESPACES` del frontend. Sin ese alta, el gestor
 * rechazaria con un 400 cualquier plantilla que interpolase
 * `{{cron_trigger.triggered_at}}` aunque el nodo hubiera escrito el dato
 * correctamente en el contexto.
 */
export const DEFAULT_CRON_OUTPUT_NAMESPACE = 'cron_trigger';

/**
 * Numero de campos exigido en la expresion: minuto, hora, dia, mes y dia de
 * semana.
 *
 * La libreria `cron` admite tambien seis campos, donde el primero son SEGUNDOS.
 * Aqui se rechaza a proposito: `* * * * * *` es sintacticamente valido y
 * dispararia el flujo cada segundo, saturando el motor con excepciones de
 * conflicto del mutex de ejecucion (RNF-09) y llenando la trazabilidad de ruido.
 * La granularidad util de un flujo editorial es el minuto.
 */
export const CRON_EXPRESSION_FIELD_COUNT = 5;

/**
 * Valida la sintaxis de la expresion cron delegando en la propia libreria.
 *
 * Las guardas propias van ANTES de delegar porque `validateCronExpression` es
 * mas permisiva de lo que este nodo quiere: acepta seis campos (segundos) y los
 * alias con arroba (`@daily`, y sobre todo `@secondly`), que se expanden
 * internamente a seis campos. Validar solo con la libreria dejaria pasar
 * configuraciones que el planificador no deberia aceptar nunca.
 */
@ValidatorConstraint({ name: 'isValidCronExpression', async: false })
export class IsValidCronExpressionConstraint implements ValidatorConstraintInterface {
  public validate(value: unknown): boolean {
    if (typeof value !== 'string') {
      return false;
    }

    const expression = value.trim();
    if (expression === '') {
      return false;
    }

    // Los alias `@...` se expanden a seis campos y uno de ellos es `@secondly`.
    if (expression.startsWith('@')) {
      return false;
    }

    if (expression.split(/\s+/).length !== CRON_EXPRESSION_FIELD_COUNT) {
      return false;
    }

    return validateCronExpression(expression).valid;
  }

  public defaultMessage(args: ValidationArguments): string {
    const expression = typeof args.value === 'string' ? args.value.trim() : '';

    // El `??` no es defensivo: cuando el rechazo viene de las guardas propias
    // —seis campos o alias— la libreria considera la expresion VALIDA y devuelve
    // `error: undefined`, asi que sin el se imprimiria un "undefined" al usuario.
    const detail =
      expression === ''
        ? ''
        : ` (${validateCronExpression(expression).error?.message ?? 'formato no admitido'})`;

    return `cronExpression debe ser una expresion cron estandar de ${CRON_EXPRESSION_FIELD_COUNT} campos (minuto hora dia mes dia-semana), sin segundos ni alias @${detail}.`;
  }
}

/**
 * Valida que la zona horaria sea un identificador IANA que luxon pueda resolver.
 *
 * Se comprueba con `Intl.DateTimeFormat`, que lanza `RangeError` ante un nombre
 * desconocido, y NO con `Intl.supportedValuesOf('timeZone')`: ese listado omite
 * los alias historicos (`Asia/Calcutta`, `Europe/Kiev`) que luxon si acepta, y
 * los rechazaria como falsos negativos.
 *
 * TIENE ESPEJO EN EL CLIENTE: `isIanaTimeZone` en
 * `frontend/src/stores/nodes/trigger-cron.store.ts`. Endurecer esta regla sin
 * tocar aquella deja al asistente aceptando zonas que luego rechaza el 400, y
 * relajarla sin tocar aquella deja nodos guardados que el asistente no puede
 * reabrir. Cualquier cambio va en los dos sitios.
 *
 * DEUDA CONOCIDA: `Etc/GMT+2` lleva barra y `Intl` lo resuelve, asi que pasa
 * pese a ser un desplazamiento fijo sin horario de verano.
 */
@ValidatorConstraint({ name: 'isIanaTimeZone', async: false })
export class IsIanaTimeZoneConstraint implements ValidatorConstraintInterface {
  public validate(value: unknown): boolean {
    if (typeof value !== 'string' || value === '') {
      return false;
    }

    // Se descartan los desplazamientos fijos ("+02:00", "UTC+2"). Tanto `Intl`
    // como luxon los aceptan, pero un offset fijo no sigue el horario de verano:
    // un flujo declarado "a las 8:00" se correria una hora durante media
    // temporada sin dar ningun error, que es el peor modo de fallo posible.
    if (value !== 'UTC' && !value.includes('/')) {
      return false;
    }

    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }

  public defaultMessage(): string {
    return `timeZone debe ser un nombre de zona IANA (ej. ${DEFAULT_CRON_TIMEZONE} o UTC); no se admiten desplazamientos fijos porque no siguen el horario de verano.`;
  }
}

/**
 * Parametros del nodo TRIGGER_CRON, tal como se declaran en `params` dentro del
 * `pipeline_schema` (columna JSONB `flujos.configuracion_pipeline`).
 *
 * Solo contempla disparo RECURRENTE. Un modo "una sola vez" exigiria distinguir
 * un disparo ya consumido de uno pendiente a traves de reinicios del proceso, y
 * arrastraria una semantica de entrega —que hacer si el backend estaba caido a
 * la hora prevista, o si el mutex de ejecucion rechazo justo ese disparo— que es
 * una decision de producto y no de implementacion. Queda fuera de alcance.
 *
 * La validacion corre con `forbidNonWhitelisted`, asi que un `params` con una
 * clave desconocida (un `cronExpresion` mal escrito, por ejemplo) se RECHAZA en
 * lugar de ignorarse en silencio y dejar el flujo sin programar.
 *
 * Los defaults se resuelven en `resolveCronConfig` con `??` y no con
 * inicializadores de propiedad, siguiendo la convencion del repositorio: un
 * inicializador solo actuaria si `plainToInstance` corriera con
 * `exposeDefaultValues`, que no es el caso.
 */
export class CronTriggerConfigDto {
  @ApiProperty({
    description: `Expresion cron estandar de ${CRON_EXPRESSION_FIELD_COUNT} campos (minuto hora dia mes dia-semana)`,
    example: '0 9 * * 1-5',
  })
  @IsString({ message: 'cronExpression debe ser una cadena.' })
  @IsNotEmpty({ message: 'cronExpression no puede estar vacio.' })
  @Validate(IsValidCronExpressionConstraint)
  cronExpression: string;

  @ApiPropertyOptional({
    description: `Zona horaria IANA en la que se interpreta la expresion. Por defecto ${DEFAULT_CRON_TIMEZONE}`,
    example: DEFAULT_CRON_TIMEZONE,
    default: DEFAULT_CRON_TIMEZONE,
  })
  @IsOptional()
  @IsString({ message: 'timeZone debe ser una cadena.' })
  @Validate(IsIanaTimeZoneConstraint)
  timeZone?: string;

  @ApiPropertyOptional({
    description:
      'Namespace declarado del nodo. El efectivo es el `outputNamespace` del pipeline_schema, que es el que usa el motor para escribir',
    example: DEFAULT_CRON_OUTPUT_NAMESPACE,
    default: DEFAULT_CRON_OUTPUT_NAMESPACE,
    pattern: OUTPUT_NAMESPACE_PATTERN.source,
  })
  @IsOptional()
  @IsString({ message: 'outputNamespace debe ser una cadena.' })
  @Matches(OUTPUT_NAMESPACE_PATTERN, {
    message: 'outputNamespace debe ser snake_case alfanumerico en minusculas.',
  })
  outputNamespace?: string;
}

/**
 * Configuracion del nodo con todos los valores por defecto ya aplicados.
 *
 * Existe por el mismo motivo que `ResolvedImapConfig`: la estrategia y el
 * planificador la consumen por separado, y un default divergente significaria
 * que el planificador dispara con una zona horaria distinta de la que el nodo
 * declara despues en su salida.
 */
export interface ResolvedCronTriggerConfig {
  readonly cronExpression: string;
  readonly timeZone: string;
  readonly outputNamespace: string;
}

/**
 * Aplica los valores por defecto sobre un DTO ya validado. Funcion pura.
 *
 * Acepta tambien una config YA resuelta y es IDEMPOTENTE sobre ella. No es un
 * detalle: la reconciliacion de `CronSchedulingService` decide si reinscribir un
 * temporizador comparando dos de estos objetos con `JSON.stringify`, asi que si
 * resolver dos veces produjese resultados distintos, cada ciclo veria un cambio
 * ficticio, destruiria el `CronJob` y reiniciaria su cuenta atras — un flujo
 * programado "cada hora" no llegaria a dispararse nunca.
 */
export const resolveCronConfig = (
  dto: CronTriggerConfigDto | ResolvedCronTriggerConfig,
): ResolvedCronTriggerConfig => ({
  // El orden de las claves es fijo y todos los valores son primitivas: es lo
  // que hace comparable con `JSON.stringify` el resultado de dos resoluciones.
  cronExpression: dto.cronExpression.trim(),
  timeZone: dto.timeZone ?? DEFAULT_CRON_TIMEZONE,
  outputNamespace: dto.outputNamespace ?? DEFAULT_CRON_OUTPUT_NAMESPACE,
});
