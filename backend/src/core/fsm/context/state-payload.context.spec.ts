import {
  MissingContextVariableException,
  StatePayloadContext,
} from '@core/fsm/context/state-payload.context';

const EXECUTION_ID = 'd4c3b2a1-9f8e-4d7c-8b6a-5e4f3d2c1b0a';
const WORKFLOW_ID = 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const INITIAL_STEP = 'paso_1';

/** Contexto recien construido, sin ningun namespace escrito. */
const buildContext = (): StatePayloadContext =>
  new StatePayloadContext(EXECUTION_ID, WORKFLOW_ID, INITIAL_STEP);

describe('StatePayloadContext (PROT-08)', () => {
  let context: StatePayloadContext;

  beforeEach(() => {
    context = buildContext();
  });

  describe('1. Inmutabilidad profunda (structuredClone)', () => {
    it('1.1 deberia impedir que mutar la salida de getNamespace alcance el estado interno', () => {
      // 1. Arrange: un array y un objeto anidado, donde falla una copia superficial
      context.setNamespace('parsed_email', {
        urls: ['https://a.com'],
        meta: { retries: 0 },
      });

      // 2. Act: se muta la copia recibida en los dos niveles
      const escaped = context.getNamespace('parsed_email');
      (escaped?.urls as string[]).push('https://inyectada.com');
      (escaped?.meta as { retries: number }).retries = 99;

      // 3. Assert: el contexto sigue exactamente como se escribio
      const stored = context.getNamespace('parsed_email');
      expect(stored?.urls).toHaveLength(1);
      expect(stored?.urls).toEqual(['https://a.com']);
      expect((stored?.meta as { retries: number }).retries).toBe(0);
    });

    it('1.2 deberia impedir que alterar o borrar en la salida de getAllContext alcance el estado interno', () => {
      // 1. Arrange: dos namespaces, ambos con sub-objetos anidados
      context.setNamespace('parsed_email', {
        title: 'Noticia Tech',
        meta: { adjuntos: ['informe.pdf'] },
      });
      context.setNamespace('scraped_web', {
        author: 'Admin',
        meta: { status: 200 },
      });

      // 2. Act: se altera una propiedad, se muta un anidado y se borra un namespace entero
      const escaped = context.getAllContext();
      escaped.parsed_email.title = 'Titulo suplantado';
      (escaped.parsed_email.meta as { adjuntos: string[] }).adjuntos.push(
        'virus.exe',
      );
      delete escaped.scraped_web;

      // 3. Assert: el contexto conserva ambos namespaces integros
      const stored = context.getAllContext();
      expect(Object.keys(stored)).toEqual(['parsed_email', 'scraped_web']);
      expect(stored.parsed_email.title).toBe('Noticia Tech');
      expect(
        (stored.parsed_email.meta as { adjuntos: string[] }).adjuntos,
      ).toEqual(['informe.pdf']);
      expect(stored.scraped_web.author).toBe('Admin');
    });

    it('1.3 deberia clonar el objeto de entrada, de modo que mutarlo tras registrarlo no contamine', () => {
      // 1. Arrange: quien llama conserva su referencia y podria reutilizarla
      const localPayload = { raw: { body: 'texto original' } };
      context.setNamespace('trigger', localPayload);

      // 2. Act
      localPayload.raw.body = 'texto manipulado post-registro';

      // 3. Assert
      const stored = context.getNamespace('trigger');
      expect((stored?.raw as { body: string }).body).toBe('texto original');
    });
  });

  describe('2. Aislamiento y fusion de namespaces', () => {
    it('2.1 deberia mantener cada namespace aislado del resto', () => {
      // 1. Arrange
      context.setNamespace('nodo_a', { dataA: 100 });

      // 2. Act
      context.setNamespace('nodo_b', { dataB: 200 });

      // 3. Assert: ninguno filtra claves del otro
      expect(context.getNamespace('nodo_a')).toEqual({ dataA: 100 });
      expect(context.getNamespace('nodo_b')).toEqual({ dataB: 200 });
    });

    it('2.2 deberia fusionar sin destruir las claves previas del mismo namespace', () => {
      // 1. Arrange
      context.setNamespace('nodo_a', { campo1: 'valor1' });

      // 2. Act: el mismo nodo escribe en una segunda tanda
      context.setNamespace('nodo_a', { campo2: 'valor2' });

      // 3. Assert
      expect(context.getNamespace('nodo_a')).toEqual({
        campo1: 'valor1',
        campo2: 'valor2',
      });
    });

    it('2.3 deberia devolver undefined para un namespace que nadie ha escrito', () => {
      // 3. Assert
      expect(context.getNamespace('namespace_fantasma')).toBeUndefined();
    });
  });

  describe('3. Motor de interpolacion (getInterpolatedValue)', () => {
    beforeEach(() => {
      context.setNamespace('parsed_email', { title: 'Noticia Tech' });
      context.setNamespace('scraped_web', { author: 'Admin' });
    });

    it('3.1 deberia sustituir varias variables de distintos namespaces', () => {
      // 1. Arrange
      const template =
        'Autor: {{ scraped_web.author }} - Titulo: {{ parsed_email.title }}';

      // 2. Act
      const result = context.getInterpolatedValue(template);

      // 3. Assert
      expect(result).toBe('Autor: Admin - Titulo: Noticia Tech');
    });

    it('3.2 deberia resolver identicamente las variantes de espaciado mustache', () => {
      // 2. Act
      const results = [
        context.getInterpolatedValue('{{  parsed_email.title  }}'),
        context.getInterpolatedValue('{{parsed_email.title}}'),
        context.getInterpolatedValue('{{ parsed_email.title}}'),
        context.getInterpolatedValue('{{parsed_email.title }}'),
      ];

      // 3. Assert
      expect(new Set(results).size).toBe(1);
      expect(results[0]).toBe('Noticia Tech');
    });

    it('3.3 deberia devolver intacta una plantilla sin variables', () => {
      // 1. Arrange
      const template = '<p>Texto fijo sin etiquetas.</p>';

      // 2. Act + 3. Assert
      expect(context.getInterpolatedValue(template)).toBe(template);
    });

    it('3.4 deberia lanzar MissingContextVariableException si el namespace no existe', () => {
      // 2. Act + 3. Assert
      expect(() => context.getInterpolatedValue('{{ ausente.campo }}')).toThrow(
        MissingContextVariableException,
      );
    });

    it('3.5 deberia lanzar MissingContextVariableException ante campo inexistente, nulo o indefinido', () => {
      // 1. Arrange: la clave puede existir y aun asi no tener valor utilizable
      context.setNamespace('nodo_x', {
        valido: 123,
        nulo: null,
        indefinido: undefined,
      });

      // 2. Act + 3. Assert
      expect(() =>
        context.getInterpolatedValue('{{ nodo_x.inexistente }}'),
      ).toThrow(MissingContextVariableException);
      expect(() => context.getInterpolatedValue('{{ nodo_x.nulo }}')).toThrow(
        MissingContextVariableException,
      );
      expect(() =>
        context.getInterpolatedValue('{{ nodo_x.indefinido }}'),
      ).toThrow(MissingContextVariableException);

      // El campo con valor si resuelve: la excepcion no es indiscriminada
      expect(context.getInterpolatedValue('{{ nodo_x.valido }}')).toBe('123');
    });

    it('3.6 deberia nombrar la variable culpable en la excepcion', () => {
      // 2. Act
      let captured: MissingContextVariableException | undefined;

      try {
        context.getInterpolatedValue('<p>{{ parsed_email.inexistente }}</p>');
      } catch (error) {
        captured = error as MissingContextVariableException;
      }

      // 3. Assert: sin el nombre, el mensaje no seria accionable
      expect(captured?.variable).toBe('parsed_email.inexistente');
      expect(captured?.message).toContain('parsed_email.inexistente');
    });

    it('3.7 deberia interpolar numeros y booleanos sin anadir comillas', () => {
      // 1. Arrange
      context.setNamespace('ia_result', { score: 42, publicado: true });

      // 2. Act
      const result = context.getInterpolatedValue(
        '{{ia_result.score}}|{{ia_result.publicado}}',
      );

      // 3. Assert
      expect(result).toBe('42|true');
    });

    it('3.8 deberia serializar objetos y arrays a JSON, nunca a [object Object]', () => {
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
  });

  describe('4. Control de cursor y metadatos', () => {
    it('4.1 deberia arrancar en el paso inicial y avanzar con setCursor', () => {
      // 1. Arrange
      expect(context.getCursor()).toBe(INITIAL_STEP);

      // 2. Act
      context.setCursor('paso_2');

      // 3. Assert
      expect(context.getCursor()).toBe('paso_2');
    });

    it('4.2 deberia exponer los identificadores inyectados en el constructor', () => {
      // 3. Assert
      expect(context.getExecutionId()).toBe(EXECUTION_ID);
      expect(context.getWorkflowId()).toBe(WORKFLOW_ID);
    });

    it('4.3 deberia avanzar el cursor sin tocar los namespaces acumulados', () => {
      // 1. Arrange
      context.setNamespace('parsed_email', { title: 'Noticia Tech' });

      // 2. Act
      context.setCursor('nodo_ia');

      // 3. Assert
      expect(context.getCursor()).toBe('nodo_ia');
      expect(context.getNamespace('parsed_email')).toEqual({
        title: 'Noticia Tech',
      });
    });
  });
});
