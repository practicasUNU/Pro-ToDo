import { promptReferenceKey } from '@core/fsm/types/prompt-text-resolver.port';

import { AiPromptTextResolverAdapter } from './ai-prompt-text-resolver.adapter';

import type { AiPromptTemplate } from './entities/ai-prompt-template.entity';
import type { Repository } from 'typeorm';

const PROMPT_ID = '9f1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const OTHER_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e';
const PROMPT_CODE = 'NOTIWEB_DEFAULT';
const PROMPT_TEXT = 'Redacta con {{scraped_web.full_article_content}}';

type RepositoryMock = jest.Mocked<Pick<Repository<AiPromptTemplate>, 'find'>>;

const buildRepository = (): RepositoryMock => ({ find: jest.fn() });

const buildPrompt = (
  overrides: Partial<AiPromptTemplate> = {},
): AiPromptTemplate =>
  ({
    id: PROMPT_ID,
    code: PROMPT_CODE,
    name: 'Notiweb · Redaccion institucional',
    description: null,
    promptText: PROMPT_TEXT,
    active: true,
    createdById: '0c1f7b52-4d3a-4e6b-8f2c-1a0b9d8e7f60',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }) as AiPromptTemplate;

const buildAdapter = (
  repository: RepositoryMock,
): AiPromptTextResolverAdapter =>
  new AiPromptTextResolverAdapter(
    repository as unknown as Repository<AiPromptTemplate>,
  );

describe('AiPromptTextResolverAdapter', () => {
  describe('1. Resolucion', () => {
    it('1.1 deberia indexar el texto por la referencia de codigo', async () => {
      // 1. Arrange
      const repository = buildRepository();
      repository.find.mockResolvedValue([buildPrompt()]);
      const adapter = buildAdapter(repository);

      // 2. Act
      const texts = await adapter.resolvePromptTexts([
        { kind: 'code', value: PROMPT_CODE },
      ]);

      // 3. Assert
      expect(texts.get(promptReferenceKey({ kind: 'code', value: PROMPT_CODE }))).toBe(
        PROMPT_TEXT,
      );
    });

    it('1.2 deberia indexar el mismo texto tambien por id', async () => {
      // 1. Arrange: una fila se indexa por sus DOS claves posibles, de modo que
      //    la consulta unica sirva a un nodo que la cita por id y a otro que la
      //    cita por codigo.
      const repository = buildRepository();
      repository.find.mockResolvedValue([buildPrompt()]);
      const adapter = buildAdapter(repository);

      // 2. Act
      const texts = await adapter.resolvePromptTexts([
        { kind: 'code', value: PROMPT_CODE },
      ]);

      // 3. Assert
      expect(texts.get(promptReferenceKey({ kind: 'id', value: PROMPT_ID }))).toBe(
        PROMPT_TEXT,
      );
    });

    it('1.3 deberia resolver ids y codigos en UNA sola consulta', async () => {
      // 1. Arrange: validar un flujo no puede costar una consulta por nodo
      const repository = buildRepository();
      repository.find.mockResolvedValue([buildPrompt()]);
      const adapter = buildAdapter(repository);

      // 2. Act
      await adapter.resolvePromptTexts([
        { kind: 'id', value: PROMPT_ID },
        { kind: 'id', value: OTHER_ID },
        { kind: 'code', value: PROMPT_CODE },
      ]);

      // 3. Assert
      expect(repository.find).toHaveBeenCalledTimes(1);
    });

    it('1.4 deberia deduplicar las referencias repetidas', async () => {
      // 1. Arrange: dos nodos citando el mismo prompt
      const repository = buildRepository();
      repository.find.mockResolvedValue([buildPrompt()]);
      const adapter = buildAdapter(repository);

      // 2. Act
      await adapter.resolvePromptTexts([
        { kind: 'code', value: PROMPT_CODE },
        { kind: 'code', value: PROMPT_CODE },
      ]);

      // 3. Assert: el `In(...)` recibe UN solo valor, no dos
      const [options] = repository.find.mock.calls[0] ?? [];
      const where = options?.where as Array<{ code: { value: string[] } }>;

      expect(where).toHaveLength(1);
      expect(where[0]?.code.value).toEqual([PROMPT_CODE]);
    });

    it('1.5 deberia resolver una plantilla DESACTIVADA', async () => {
      // 1. Arrange: de que namespaces depende el flujo no cambia porque alguien
      //    retire el prompt del selector. De la plantilla retirada se queja la
      //    ejecucion, no el validador de topologia.
      const repository = buildRepository();
      repository.find.mockResolvedValue([buildPrompt({ active: false })]);
      const adapter = buildAdapter(repository);

      // 2. Act
      const texts = await adapter.resolvePromptTexts([
        { kind: 'code', value: PROMPT_CODE },
      ]);

      // 3. Assert
      expect(texts.size).toBeGreaterThan(0);
    });
  });

  describe('2. Ausencias y guardas', () => {
    it('2.1 no deberia consultar nada sin referencias', async () => {
      // 1. Arrange: el caso normal de un flujo sin prompts guardados
      const repository = buildRepository();
      const adapter = buildAdapter(repository);

      // 2. Act
      const texts = await adapter.resolvePromptTexts([]);

      // 3. Assert
      expect(repository.find).not.toHaveBeenCalled();
      expect(texts.size).toBe(0);
    });

    it('2.2 deberia devolver un mapa vacio cuando no existe la fila', async () => {
      // 1. Arrange: omitir es el contrato del puerto. Lanzar aqui convertiria un
      //    prompt borrado en un falso fallo de dependencias.
      const repository = buildRepository();
      repository.find.mockResolvedValue([]);
      const adapter = buildAdapter(repository);

      // 2. Act
      const texts = await adapter.resolvePromptTexts([
        { kind: 'code', value: 'NO_EXISTE' },
      ]);

      // 3. Assert
      expect(texts.size).toBe(0);
    });

    it('2.3 deberia descartar un id que no tiene forma de UUID', async () => {
      // 1. Arrange: PostgreSQL no sabe comparar `uuid` con una cadena
      //    arbitraria, y el error que lanzaria no seria un 400 legible.
      const repository = buildRepository();
      const adapter = buildAdapter(repository);

      // 2. Act
      const texts = await adapter.resolvePromptTexts([
        { kind: 'id', value: 'no-soy-un-uuid' },
      ]);

      // 3. Assert
      expect(repository.find).not.toHaveBeenCalled();
      expect(texts.size).toBe(0);
    });

    it('2.4 deberia conservar los codigos cuando el unico id es invalido', async () => {
      // 1. Arrange: descartar el id no puede llevarse por delante la consulta
      const repository = buildRepository();
      repository.find.mockResolvedValue([buildPrompt()]);
      const adapter = buildAdapter(repository);

      // 2. Act
      await adapter.resolvePromptTexts([
        { kind: 'id', value: 'basura' },
        { kind: 'code', value: PROMPT_CODE },
      ]);

      // 3. Assert
      expect(repository.find).toHaveBeenCalledTimes(1);
    });
  });
});
