import {
  MissingContextVariableException,
  StatePayloadContext,
} from '@core/fsm/context/state-payload.context';

const EXECUTION_ID = 'exec-123';
const WORKFLOW_ID = 'flujo-notiweb';
const INITIAL_STEP = 'nodo_trigger';

/** Contexto recien construido, sin ningun namespace escrito. */
const buildContext = (): StatePayloadContext =>
  new StatePayloadContext(EXECUTION_ID, WORKFLOW_ID, INITIAL_STEP);

describe('StatePayloadContext (PROT-08)', () => {
  let context: StatePayloadContext;

  beforeEach(() => {
    context = buildContext();
  });

  describe('inmutabilidad', () => {
    it('deberia devolver una copia profunda en getNamespace', () => {
      // 1. Arrange: un objeto anidado es donde falla una copia superficial
      context.setNamespace('parsed_email', {
        subject: 'Innovacion en Madrid',
        meta: { adjuntos: ['informe.pdf'] },
      });

      // 2. Act: se muta la salida en los dos niveles
      const escaped = context.getNamespace('parsed_email');
      escaped!.subject = 'Titulo suplantado';
      (escaped!.meta as { adjuntos: string[] }).adjuntos.push('virus.exe');

      // 3. Assert: el estado interno permanece intacto
      const stored = context.getNamespace('parsed_email');
      expect(stored?.subject).toBe('Innovacion en Madrid');
      expect((stored?.meta as { adjuntos: string[] }).adjuntos).toEqual([
        'informe.pdf',
      ]);
    });

    it('deberia devolver una copia profunda en getAllContext', () => {
      // 1. Arrange
      context.setNamespace('ia_result', { titulo: 'Original', tags: ['a'] });

      // 2. Act
      const escaped = context.getAllContext();
      escaped.ia_result.titulo = 'Suplantado';
      (escaped.ia_result.tags as string[]).push('b');

      // 3. Assert
      const stored = context.getAllContext();
      expect(stored.ia_result.titulo).toBe('Original');
      expect(stored.ia_result.tags).toEqual(['a']);
    });

    it('deberia clonar tambien el objeto de entrada de setNamespace', () => {
      // 1. Arrange: quien llama conserva su referencia y podria reutilizarla
      const payload = { titulo: 'Original', meta: { fuente: 'imap' } };
      context.setNamespace('ia_result', payload);

      // 2. Act
      payload.titulo = 'Mutado despues de escribir';
      payload.meta.fuente = 'suplantada';

      // 3. Assert
      const stored = context.getNamespace('ia_result');
      expect(stored?.titulo).toBe('Original');
      expect((stored?.meta as { fuente: string }).fuente).toBe('imap');
    });
  });

  describe('aislamiento entre namespaces', () => {
    it('deberia conservar los namespaces previos al escribir en uno nuevo', () => {
      // 1. Arrange
      context.setNamespace('parsed_email', { subject: 'Asunto' });

      // 2. Act
      context.setNamespace('scraped_web', { html: '<article/>' });

      // 3. Assert
      expect(context.getNamespace('parsed_email')).toEqual({
        subject: 'Asunto',
      });
      expect(context.getNamespace('scraped_web')).toEqual({
        html: '<article/>',
      });
    });

    it('deberia fusionar claves nuevas sin borrar las previas del mismo namespace', () => {
      // 1. Arrange
      context.setNamespace('ia_result', { titulo: 'Titulo' });

      // 2. Act: el mismo nodo escribe en una segunda tanda
      context.setNamespace('ia_result', { resumen: 'Resumen' });

      // 3. Assert
      expect(context.getNamespace('ia_result')).toEqual({
        titulo: 'Titulo',
        resumen: 'Resumen',
      });
    });

    it('deberia devolver undefined para un namespace que nadie ha escrito', () => {
      // 3. Assert
      expect(context.getNamespace('inexistente')).toBeUndefined();
    });
  });

  describe('getInterpolatedValue', () => {
    beforeEach(() => {
      context.setNamespace('parsed_email', {
        subject: 'Innovacion en Madrid',
        sender: 'prensa@unuware.com',
      });
      context.setNamespace('ia_result', { resumen: 'Resumen estructurado' });
    });

    it('deberia sustituir varias variables de distintos namespaces', () => {
      // 1. Arrange
      const template =
        '<h1>{{parsed_email.subject}}</h1><p>{{ia_result.resumen}}</p><i>{{parsed_email.sender}}</i>';

      // 2. Act
      const result = context.getInterpolatedValue(template);

      // 3. Assert
      expect(result).toBe(
        '<h1>Innovacion en Madrid</h1><p>Resumen estructurado</p><i>prensa@unuware.com</i>',
      );
    });

    it('deberia tolerar espacios dentro de las llaves', () => {
      // 3. Assert
      expect(context.getInterpolatedValue('{{  parsed_email.subject  }}')).toBe(
        'Innovacion en Madrid',
      );
    });

    it('deberia devolver intacta una plantilla sin variables', () => {
      // 3. Assert
      expect(context.getInterpolatedValue('<p>Texto fijo</p>')).toBe(
        '<p>Texto fijo</p>',
      );
    });

    it('deberia interpolar numeros y booleanos sin comillas', () => {
      // 1. Arrange
      context.setNamespace('ia_result', { score: 42, publicado: true });

      // 2. Act
      const result = context.getInterpolatedValue(
        '{{ia_result.score}}|{{ia_result.publicado}}',
      );

      // 3. Assert
      expect(result).toBe('42|true');
    });

    it('deberia serializar objetos y arrays a JSON, nunca a [object Object]', () => {
      // 1. Arrange: un mapeo erroneo podria apuntar a una clave no escalar
      context.setNamespace('ia_result', {
        tags: ['madrid', 'innovacion'],
        meta: { fuente: 'imap' },
      });

      // 2. Act
      const result = context.getInterpolatedValue(
        '{{ia_result.tags}}|{{ia_result.meta}}',
      );

      // 3. Assert
      expect(result).toBe('["madrid","innovacion"]|{"fuente":"imap"}');
      expect(result).not.toContain('[object Object]');
    });

    it('deberia lanzar MissingContextVariableException si el campo no existe', () => {
      // 2. Act + 3. Assert
      expect(() =>
        context.getInterpolatedValue('{{parsed_email.inexistente}}'),
      ).toThrow(MissingContextVariableException);
    });

    it('deberia lanzar MissingContextVariableException si el namespace no existe', () => {
      // 2. Act + 3. Assert
      expect(() =>
        context.getInterpolatedValue('{{nodo_fantasma.campo}}'),
      ).toThrow(MissingContextVariableException);
    });

    it('deberia tratar un valor null explicito como variable ausente', () => {
      // 1. Arrange: la IA devolvio la clave, pero vacia
      context.setNamespace('ia_result', { titulo: null });

      // 2. Act + 3. Assert
      expect(() =>
        context.getInterpolatedValue('{{ia_result.titulo}}'),
      ).toThrow(MissingContextVariableException);
    });

    it('deberia nombrar la variable culpable en la excepcion', () => {
      // 2. Act
      let captured: MissingContextVariableException | undefined;

      try {
        context.getInterpolatedValue('<p>{{ia_result.inexistente}}</p>');
      } catch (error) {
        captured = error as MissingContextVariableException;
      }

      // 3. Assert
      expect(captured?.variable).toBe('ia_result.inexistente');
      expect(captured?.message).toContain('ia_result.inexistente');
    });
  });

  describe('cursor e identificadores', () => {
    it('deberia arrancar en el paso inicial recibido por constructor', () => {
      // 3. Assert
      expect(context.getCursor()).toBe(INITIAL_STEP);
      expect(context.getExecutionId()).toBe(EXECUTION_ID);
      expect(context.getWorkflowId()).toBe(WORKFLOW_ID);
    });

    it('deberia avanzar el cursor sin tocar los namespaces', () => {
      // 1. Arrange
      context.setNamespace('parsed_email', { subject: 'Asunto' });

      // 2. Act
      context.setCursor('nodo_ia');

      // 3. Assert
      expect(context.getCursor()).toBe('nodo_ia');
      expect(context.getNamespace('parsed_email')).toEqual({
        subject: 'Asunto',
      });
    });
  });
});
