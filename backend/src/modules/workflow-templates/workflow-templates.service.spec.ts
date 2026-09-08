import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';

import { WorkflowTemplatesService } from './workflow-templates.service';

import type { CreateWorkflowTemplateDto } from './dto/create-workflow-template.dto';
import type { WorkflowTemplate } from './entities/workflow-template.entity';
import type { PipelineSchemaDto } from '@core/fsm/dto/pipeline-schema.dto';
import type { PipelineValidatorService } from '@core/fsm/services/pipeline-validator.service';
import type { Repository } from 'typeorm';

const TEMPLATE_ID = '5e2d1c4b-7a89-4f30-b1c2-6d5e4f3a2b10';
const OTHER_TEMPLATE_ID = '7f3a2b1c-9d8e-4f60-a1b2-3c4d5e6f7a80';
const TRIGGER_NODE_ID = 'trigger_imap';
const MAPPER_NODE_ID = 'nodo_mapeador';

/**
 * Topologia base de dos nodos, con las claves del mapa en orden INVERSO al de
 * ejecucion: es lo que distingue el recorrido real de un `Object.values()`.
 */
const buildSchema = (): PipelineSchemaDto => ({
  flowId: 'plantilla-notiweb',
  name: 'Notiweb - correo a CMS',
  version: '1.0.0',
  entrypoint: TRIGGER_NODE_ID,
  nodes: {
    [MAPPER_NODE_ID]: {
      nodeId: MAPPER_NODE_ID,
      nodeType: NodeType.MAPEADOR_PLANTILLA,
      outputNamespace: 'rendered_html',
      nextStep: null,
      onErrorStep: null,
      params: { templateId: null },
    },
    [TRIGGER_NODE_ID]: {
      nodeId: TRIGGER_NODE_ID,
      nodeType: NodeType.TRIGGER_IMAP,
      outputNamespace: 'raw_email',
      nextStep: MAPPER_NODE_ID,
      onErrorStep: null,
      // Datos de infraestructura: la prueba 1.4 verifica que NO viajan.
      params: { host: 'imap.unuware.com', passwordEnvKey: 'IMAP_PASSWORD' },
    },
  },
});

const buildTemplate = (
  overrides: Partial<WorkflowTemplate> = {},
): WorkflowTemplate => ({
  id: TEMPLATE_ID,
  name: 'Notiweb - correo a CMS',
  description: 'Ingesta por correo y publicacion en el CMS',
  active: true,
  pipelineSchema: buildSchema(),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const buildCreateDto = (
  overrides: Partial<CreateWorkflowTemplateDto> = {},
): CreateWorkflowTemplateDto => ({
  name: 'Notiweb - correo a CMS',
  description: 'Ingesta por correo y publicacion en el CMS',
  pipelineSchema: buildSchema() as unknown as Record<string, unknown>,
  ...overrides,
});

interface Harness {
  readonly service: WorkflowTemplatesService;
  readonly repository: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  readonly validateSchema: jest.Mock;
}

/**
 * Servicio con repositorio y validador doblados.
 *
 * `validateSchema` se mockea con exito por defecto devolviendo el esquema tal
 * cual, que es su contrato real: valida y retorna la instancia del DTO. Las
 * pruebas negativas lo hacen rechazar.
 */
const buildHarness = (): Harness => {
  const repository = {
    find: jest.fn(),
    findOne: jest.fn(),
    // El repositorio real fusiona el parcial en una entidad nueva.
    create: jest.fn((partial: Partial<WorkflowTemplate>) =>
      buildTemplate(partial),
    ),
    save: jest.fn((entity: WorkflowTemplate) => Promise.resolve(entity)),
  };

  const validateSchema = jest.fn((raw: unknown) => Promise.resolve(raw));

  const service = new WorkflowTemplatesService(
    repository as unknown as Repository<WorkflowTemplate>,
    { validateSchema } as unknown as PipelineValidatorService,
  );

  return { service, repository, validateSchema };
};

describe('WorkflowTemplatesService · catalogo de plantillas de flujo', () => {
  describe('1. Listado', () => {
    it('1.1 deberia filtrar por activo y ordenar por nombre', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.find.mockResolvedValue([buildTemplate()]);

      // 2. Act
      await service.findAll();

      // 3. Assert: el consumidor natural es el selector del asistente, donde el
      //    operador busca por nombre, no por fecha de creacion.
      expect(repository.find).toHaveBeenCalledWith({
        where: { active: true },
        order: { name: 'ASC' },
      });
    });

    it('1.2 deberia incluir las retiradas cuando se piden', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.find.mockResolvedValue([]);

      // 2. Act
      await service.findAll(false);

      // 3. Assert: sin filtro de estado, para la tabla administrativa.
      expect(repository.find).toHaveBeenCalledWith({
        where: {},
        order: { name: 'ASC' },
      });
    });

    it('1.3 deberia devolver la topologia en orden de ejecucion', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.find.mockResolvedValue([buildTemplate()]);

      // 2. Act
      const [summary] = await service.findAll();

      // 3. Assert: el fixture declara el mapeador ANTES del trigger, asi que el
      //    orden correcto solo sale de recorrer `entrypoint` -> `nextStep`.
      expect(summary?.topology.map((step) => step.nodeId)).toEqual([
        TRIGGER_NODE_ID,
        MAPPER_NODE_ID,
      ]);
    });

    it('1.4 no deberia exponer los params de ningun nodo', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.find.mockResolvedValue([buildTemplate()]);

      // 2. Act
      const summaries = await service.findAll();

      // 3. Assert: `passwordEnvKey` y `host` son configuracion de
      //    infraestructura; el selector no los necesita y filtrarlos evita que
      //    un endpoint de listado se convierta en una fuga.
      const serialized = JSON.stringify(summaries);
      expect(serialized).not.toContain('passwordEnvKey');
      expect(serialized).not.toContain('imap.unuware.com');
    });
  });

  describe('2. Consulta individual', () => {
    it('2.1 deberia incluir el pipeline_schema completo en el detalle', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(buildTemplate());

      // 2. Act
      const detail = await service.findOne(TEMPLATE_ID);

      // 3. Assert: el editor administrativo edita este objeto, asi que aqui SI
      //    tiene que viajar, a diferencia del listado.
      expect(detail.pipelineSchema).toEqual(buildSchema());
      expect(detail.topology).toHaveLength(2);
    });

    it('2.2 deberia lanzar NotFoundException si no existe', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(null);

      // 2. Act & 3. Assert
      await expect(service.findOne(TEMPLATE_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('3. Alta', () => {
    it('3.1 deberia validar el grafo y persistir la plantilla', async () => {
      // 1. Arrange
      const { service, repository, validateSchema } = buildHarness();
      repository.findOne
        .mockResolvedValueOnce(null) // assertNameAvailable
        .mockResolvedValue(buildTemplate()); // findOne del retorno

      // 2. Act
      await service.create(buildCreateDto());

      // 3. Assert
      expect(validateSchema).toHaveBeenCalledTimes(1);
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Notiweb - correo a CMS',
          active: true,
        }),
      );
    });

    it('3.2 deberia nacer activa cuando no se indica lo contrario', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValue(buildTemplate());

      // 2. Act
      await service.create(buildCreateDto());

      // 3. Assert: al contrario que un flujo, una plantilla no dispara nada, asi
      //    que publicarla de entrada no tiene riesgo.
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ active: true }),
      );
    });

    it('3.3 deberia respetar active: false explicito', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValue(buildTemplate({ active: false }));

      // 2. Act
      await service.create(buildCreateDto({ active: false }));

      // 3. Assert
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ active: false }),
      );
    });

    it('3.4 deberia rechazar un nombre ya registrado', async () => {
      // 1. Arrange
      const { service, repository, validateSchema } = buildHarness();
      repository.findOne.mockResolvedValue(buildTemplate());

      // 2. Act & 3. Assert
      await expect(service.create(buildCreateDto())).rejects.toThrow(
        ConflictException,
      );
      // El nombre se comprueba ANTES del grafo: es la validacion mas barata y la
      // que el usuario corrige mas a menudo.
      expect(validateSchema).not.toHaveBeenCalled();
    });

    it('3.5 deberia propagar el fallo de validacion del grafo', async () => {
      // 1. Arrange
      const { service, repository, validateSchema } = buildHarness();
      repository.findOne.mockResolvedValue(null);
      validateSchema.mockRejectedValue(
        new BadRequestException({ issues: [{ field: 'entrypoint' }] }),
      );

      // 2. Act & 3. Assert
      await expect(service.create(buildCreateDto())).rejects.toThrow(
        BadRequestException,
      );
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('3.6 deberia recortar los espacios del nombre y la descripcion', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValue(buildTemplate());

      // 2. Act
      await service.create(
        buildCreateDto({ name: '  Notiweb  ', description: '  Ingesta  ' }),
      );

      // 3. Assert
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Notiweb', description: 'Ingesta' }),
      );
    });

    it('3.7 deberia guardar description en null cuando no llega', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValue(buildTemplate());
      // El DTO se construye SIN la clave en vez de borrarla: los campos son
      // `readonly`, asi que `delete` no compila.
      const dto: CreateWorkflowTemplateDto = {
        name: 'Notiweb - correo a CMS',
        pipelineSchema: buildSchema() as unknown as Record<string, unknown>,
      };

      // 2. Act
      await service.create(dto);

      // 3. Assert: la columna es nullable; un `undefined` dejaria el campo sin
      //    definir en la entidad en vez de explicitamente vacio.
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ description: null }),
      );
    });
  });

  describe('4. Edicion', () => {
    it('4.1 deberia permitir renombrar sin colisionar consigo misma', async () => {
      // 1. Arrange: la busqueda por nombre devuelve la MISMA plantilla.
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(buildTemplate());

      // 2. Act
      const updated = await service.update(TEMPLATE_ID, {
        name: 'Notiweb - correo a CMS',
      });

      // 3. Assert: el nombre propio no es un conflicto; sin la comparacion de id
      //    seria imposible guardar una plantilla sin renombrarla.
      expect(updated.name).toBe('Notiweb - correo a CMS');
    });

    it('4.2 deberia rechazar un nombre que ya usa OTRA plantilla', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.findOne
        .mockResolvedValueOnce(buildTemplate()) // findOneEntity
        .mockResolvedValueOnce(buildTemplate({ id: OTHER_TEMPLATE_ID })); // por nombre

      // 2. Act & 3. Assert
      await expect(
        service.update(TEMPLATE_ID, { name: 'Otro nombre' }),
      ).rejects.toThrow(ConflictException);
    });

    it('4.3 deberia revalidar el grafo al cambiarlo', async () => {
      // 1. Arrange
      const { service, repository, validateSchema } = buildHarness();
      repository.findOne.mockResolvedValue(buildTemplate());

      // 2. Act
      await service.update(TEMPLATE_ID, {
        pipelineSchema: buildSchema() as unknown as Record<string, unknown>,
      });

      // 3. Assert: una plantilla es el punto de partida de N flujos; guardar un
      //    grafo roto lo propagaria a cada uno de ellos.
      expect(validateSchema).toHaveBeenCalledTimes(1);
    });

    it('4.4 deberia inactivar con active: false sin tocar la topologia', async () => {
      // 1. Arrange
      const { service, repository, validateSchema } = buildHarness();
      repository.findOne.mockResolvedValue(buildTemplate());

      // 2. Act
      await service.update(TEMPLATE_ID, { active: false });

      // 3. Assert: un solo verbo cubre editar, activar e inactivar. Comprobar
      //    `!== undefined` y no la veracidad del valor es lo que permite enviar
      //    `false` sin que se ignore.
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ active: false }),
      );
      expect(validateSchema).not.toHaveBeenCalled();
    });

    it('4.5 no deberia tocar los campos que no viajan en el cuerpo', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(buildTemplate());

      // 2. Act
      await service.update(TEMPLATE_ID, { active: false });

      // 3. Assert
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Notiweb - correo a CMS',
          description: 'Ingesta por correo y publicacion en el CMS',
        }),
      );
    });

    it('4.6 deberia lanzar NotFoundException sobre una plantilla inexistente', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(null);

      // 2. Act & 3. Assert
      await expect(
        service.update(TEMPLATE_ID, { active: false }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('5. Borrado logico', () => {
    it('5.1 deberia marcar active: false sin borrar la fila', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(buildTemplate());

      // 2. Act
      await service.softDelete(TEMPLATE_ID);

      // 3. Assert: los flujos instanciados apuntan a esta fila con
      //    `id_plantilla_origen`; borrarla los dejaria sin la pieza que explica
      //    de donde salio su topologia.
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: TEMPLATE_ID, active: false }),
      );
    });

    it('5.2 deberia lanzar NotFoundException si no existe', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(null);

      // 2. Act & 3. Assert
      await expect(service.softDelete(TEMPLATE_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(repository.save).not.toHaveBeenCalled();
    });
  });

  describe('6. Instanciabilidad', () => {
    it('6.1 deberia devolver la plantilla activa', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(buildTemplate());

      // 2. Act
      const template = await service.assertInstantiable(TEMPLATE_ID);

      // 3. Assert
      expect(template.id).toBe(TEMPLATE_ID);
    });

    it('6.2 deberia rechazar una plantilla retirada', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(buildTemplate({ active: false }));

      // 2. Act & 3. Assert: permitir instanciar una retirada vaciaria de sentido
      //    el borrado logico, que existe justo para que deje de usarse.
      await expect(service.assertInstantiable(TEMPLATE_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('6.3 deberia lanzar NotFoundException si no existe', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(null);

      // 2. Act & 3. Assert
      await expect(service.assertInstantiable(TEMPLATE_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
