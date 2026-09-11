import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  CRON_EXPRESSION_FIELD_COUNT,
  CronTriggerConfigDto,
  DEFAULT_CRON_OUTPUT_NAMESPACE,
  DEFAULT_CRON_TIMEZONE,
  IsIanaTimeZoneConstraint,
  IsValidCronExpressionConstraint,
  resolveCronConfig,
} from './cron-trigger-config.dto';

import type { ValidationError } from 'class-validator';

const VALID_EXPRESSION = '0 9 * * 1-5';

/**
 * Valida como lo hace el planificador: con `forbidNonWhitelisted`, para que una
 * clave desconocida sea un rechazo y no una omision silenciosa.
 */
const validateParams = async (
  params: Record<string, unknown>,
): Promise<ValidationError[]> => {
  const dto = plainToInstance(CronTriggerConfigDto, params);
  return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
};

const propertiesOf = (errors: ValidationError[]): string[] =>
  errors.map((error) => error.property);

describe('CronTriggerConfigDto', () => {
  describe('1. Validacion de la expresion cron', () => {
    it.each([
      ['0 9 * * 1-5', 'todos los dias laborables a las nueve'],
      ['*/15 * * * *', 'cada cuarto de hora'],
      ['0 0 1 * *', 'el primer dia de cada mes'],
    ])('1.1 deberia aceptar "%s" (%s)', async (cronExpression) => {
      // 1. Arrange & 2. Act
      const errors = await validateParams({ cronExpression });

      // 3. Assert
      expect(errors).toHaveLength(0);
    });

    it('1.2 deberia rechazar una expresion sin sentido sintactico', async () => {
      // 1. Arrange & 2. Act
      const errors = await validateParams({
        cronExpression: 'todos los lunes',
      });

      // 3. Assert
      expect(propertiesOf(errors)).toContain('cronExpression');
    });

    it('1.3 deberia rechazar una expresion de seis campos (segundos)', async () => {
      // 1. Arrange: `cron` la considera valida, pero dispararia cada segundo y
      //    saturaria el motor con conflictos del mutex de ejecucion.
      // 2. Act
      const errors = await validateParams({ cronExpression: '* * * * * *' });

      // 3. Assert
      expect(propertiesOf(errors)).toContain('cronExpression');
    });

    it.each(['@daily', '@hourly', '@secondly'])(
      '1.4 deberia rechazar el alias "%s"',
      async (cronExpression) => {
        // 1. Arrange & 2. Act
        const errors = await validateParams({ cronExpression });

        // 3. Assert
        expect(propertiesOf(errors)).toContain('cronExpression');
      },
    );

    it('1.5 deberia rechazar un campo fuera de rango', async () => {
      // 1. Arrange & 2. Act: 99 no es un minuto valido.
      const errors = await validateParams({ cronExpression: '99 * * * *' });

      // 3. Assert
      expect(propertiesOf(errors)).toContain('cronExpression');
    });

    it('1.6 deberia rechazar la expresion ausente o vacia', async () => {
      // 1. Arrange & 2. Act
      const missing = await validateParams({});
      const empty = await validateParams({ cronExpression: '   ' });

      // 3. Assert
      expect(propertiesOf(missing)).toContain('cronExpression');
      expect(propertiesOf(empty)).toContain('cronExpression');
    });

    it('1.7 deberia describir el numero de campos exigido sin imprimir "undefined"', () => {
      // 1. Arrange: con seis campos la libreria devuelve `error: undefined`,
      //    asi que el mensaje debe apoyarse en el texto propio.
      const constraint = new IsValidCronExpressionConstraint();

      // 2. Act
      const message = constraint.defaultMessage({
        value: '* * * * * *',
      } as never);

      // 3. Assert
      expect(message).toContain(String(CRON_EXPRESSION_FIELD_COUNT));
      expect(message).not.toContain('undefined');
    });
  });

  describe('2. Validacion de la zona horaria', () => {
    it.each([
      'Europe/Madrid',
      'UTC',
      'America/Argentina/Buenos_Aires',
      'America/Caracas',
    ])('2.1 deberia aceptar la zona IANA "%s"', async (timeZone) => {
      // 1. Arrange & 2. Act
      const errors = await validateParams({
        cronExpression: VALID_EXPRESSION,
        timeZone,
      });

      // 3. Assert
      expect(errors).toHaveLength(0);
    });

    it('2.2 deberia rechazar una zona inexistente', async () => {
      // 1. Arrange & 2. Act
      const errors = await validateParams({
        cronExpression: VALID_EXPRESSION,
        timeZone: 'Marte/Olympus',
      });

      // 3. Assert
      expect(propertiesOf(errors)).toContain('timeZone');
    });

    it.each(['+02:00', 'UTC+2', 'GMT+1'])(
      '2.3 deberia rechazar el desplazamiento fijo "%s"',
      async (timeZone) => {
        // 1. Arrange: un offset fijo no sigue el horario de verano y correria
        //    el flujo una hora durante media temporada, sin dar ningun error.
        // 2. Act
        const errors = await validateParams({
          cronExpression: VALID_EXPRESSION,
          timeZone,
        });

        // 3. Assert
        expect(propertiesOf(errors)).toContain('timeZone');
      },
    );

    it('2.4 deberia aceptar un alias historico que Intl.supportedValuesOf omite', () => {
      // 1. Arrange: es el motivo de validar con `DateTimeFormat` y no con el
      //    listado, que daria un falso negativo aqui.
      const constraint = new IsIanaTimeZoneConstraint();

      // 2. Act & 3. Assert
      expect(constraint.validate('Asia/Calcutta')).toBe(true);
    });
  });

  describe('3. Namespace de salida y claves desconocidas', () => {
    it('3.1 deberia rechazar un namespace que no sea snake_case', async () => {
      // 1. Arrange & 2. Act
      const errors = await validateParams({
        cronExpression: VALID_EXPRESSION,
        outputNamespace: 'CronTrigger',
      });

      // 3. Assert
      expect(propertiesOf(errors)).toContain('outputNamespace');
    });

    it('3.2 deberia rechazar una clave desconocida en lugar de ignorarla', async () => {
      // 1. Arrange: un `cronExpresion` mal escrito dejaria el flujo sin
      //    programar y sin ningun aviso si la clave se descartase en silencio.
      // 2. Act
      const errors = await validateParams({
        cronExpression: VALID_EXPRESSION,
        cronExpresion: '* * * * *',
      });

      // 3. Assert
      expect(propertiesOf(errors)).toContain('cronExpresion');
    });
  });

  describe('4. resolveCronConfig', () => {
    it('4.1 deberia aplicar los valores por defecto', () => {
      // 1. Arrange
      const dto = plainToInstance(CronTriggerConfigDto, {
        cronExpression: VALID_EXPRESSION,
      });

      // 2. Act
      const resolved = resolveCronConfig(dto);

      // 3. Assert
      expect(resolved).toEqual({
        cronExpression: VALID_EXPRESSION,
        timeZone: DEFAULT_CRON_TIMEZONE,
        outputNamespace: DEFAULT_CRON_OUTPUT_NAMESPACE,
      });
    });

    it('4.2 deberia respetar los valores explicitos', () => {
      // 1. Arrange
      const dto = plainToInstance(CronTriggerConfigDto, {
        cronExpression: '*/30 * * * *',
        timeZone: 'UTC',
        outputNamespace: 'disparo_programado',
      });

      // 2. Act
      const resolved = resolveCronConfig(dto);

      // 3. Assert
      expect(resolved.timeZone).toBe('UTC');
      expect(resolved.outputNamespace).toBe('disparo_programado');
    });

    it('4.3 deberia normalizar los espacios sobrantes de la expresion', () => {
      // 1. Arrange
      const dto = plainToInstance(CronTriggerConfigDto, {
        cronExpression: `  ${VALID_EXPRESSION}  `,
      });

      // 2. Act
      const resolved = resolveCronConfig(dto);

      // 3. Assert
      expect(resolved.cronExpression).toBe(VALID_EXPRESSION);
    });

    it('4.4 deberia ser idempotente sobre una config ya resuelta', () => {
      // 1. Arrange: el diffing de la reconciliacion compara con JSON.stringify,
      //    asi que una segunda resolucion divergente destruiria y recrearia el
      //    temporizador en cada ciclo, reiniciando su cuenta atras para siempre.
      const dto = plainToInstance(CronTriggerConfigDto, {
        cronExpression: VALID_EXPRESSION,
      });
      const once = resolveCronConfig(dto);

      // 2. Act
      const twice = resolveCronConfig(once);

      // 3. Assert
      expect(twice).toEqual(once);
      expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    });
  });
});
