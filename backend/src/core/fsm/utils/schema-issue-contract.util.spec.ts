import { BadRequestException } from '@nestjs/common';

import { toIssueContract } from '@core/fsm/utils/schema-issue-contract.util';

describe('toIssueContract (contrato publico del validador FSM)', () => {
  describe('1. Despliegue de restricciones', () => {
    it('1.1 deberia traducir field/constraints a path/message', () => {
      // 1. Arrange
      const body = {
        issues: [
          {
            field: 'nodes.trigger_imap.params.mailbox',
            constraints: ['mailbox no puede estar vacio.'],
          },
        ],
      };

      // 2. Act
      const issues = toIssueContract(body);

      // 3. Assert
      expect(issues).toEqual([
        {
          path: 'nodes.trigger_imap.params.mailbox',
          message: 'mailbox no puede estar vacio.',
        },
      ]);
    });

    it('1.2 deberia emitir UN issue por cada restriccion del mismo campo', () => {
      // 1. Arrange
      const body = {
        issues: [
          {
            field: 'version',
            constraints: [
              'version debe ser una cadena.',
              'version debe seguir el formato SemVer MAJOR.MINOR.PATCH.',
            ],
          },
        ],
      };

      // 2. Act
      const issues = toIssueContract(body);

      // 3. Assert: el editor dibuja un diagnostico por elemento. Concatenar los
      // dos motivos daria un tooltip con dos frases pegadas e inseparables.
      expect(issues).toHaveLength(2);
      expect(issues.every((issue) => issue.path === 'version')).toBe(true);
      expect(issues.map((issue) => issue.message)).toEqual([
        'version debe ser una cadena.',
        'version debe seguir el formato SemVer MAJOR.MINOR.PATCH.',
      ]);
    });

    it('1.3 deberia conservar el orden y las rutas de varios campos', () => {
      // 1. Arrange
      const body = {
        issues: [
          { field: 'entrypoint', constraints: ['entrypoint no puede estar vacio.'] },
          { field: 'nodes.nodo_ia.retryPolicy.maxRetries', constraints: ['maxRetries no puede superar 5.'] },
        ],
      };

      // 2. Act
      const issues = toIssueContract(body);

      // 3. Assert: la ruta anidada es lo que permite al editor senalar el nodo
      // culpable y no solo el documento entero.
      expect(issues.map((issue) => issue.path)).toEqual([
        'entrypoint',
        'nodes.nodo_ia.retryPolicy.maxRetries',
      ]);
    });

    it('1.4 deberia dar un mensaje de reserva a un issue sin restricciones', () => {
      // 1. Arrange
      const body = { issues: [{ field: '(root)', constraints: [] }] };

      // 2. Act
      const issues = toIssueContract(body);

      // 3. Assert: descartarlo dejaria el campo culpable sin senalar en el
      // editor, que es peor que un mensaje generico.
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toBe('(root)');
      expect(issues[0]?.message).not.toBe('');
    });
  });

  describe('2. Cuerpos que no son del validador', () => {
    it.each([
      ['una cadena', 'Bad Request'],
      ['null', null],
      ['un objeto sin issues', { message: 'otro error' }],
      ['issues que no es un arreglo', { issues: 'roto' }],
    ])('2.x deberia devolver [] ante %s', (_label: string, body: unknown) => {
      // 2. Act & 3. Assert: el endpoint no debe reventar traduciendo un error
      // que no venga del validador.
      expect(toIssueContract(body)).toEqual([]);
    });

    it('2.5 deberia leer el cuerpo real de una BadRequestException', () => {
      // 1. Arrange: la forma exacta que arma `PipelineValidatorService`.
      const exception = new BadRequestException({
        statusCode: 400,
        error: 'PIPELINE_SCHEMA_INVALIDO',
        message: 'El esquema del pipeline no supera la validacion.',
        issues: [{ field: 'flowId', constraints: ['flowId no puede estar vacio.'] }],
      });

      // 2. Act
      const issues = toIssueContract(exception.getResponse());

      // 3. Assert
      expect(issues).toEqual([
        { path: 'flowId', message: 'flowId no puede estar vacio.' },
      ]);
    });
  });
});
