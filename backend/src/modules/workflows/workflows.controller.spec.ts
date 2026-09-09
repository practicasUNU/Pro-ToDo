import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { ExecutionState } from '@core/fsm/types/fsm.enums';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { UserRole } from '@modules/users/enums/user-role.enum';

import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';

import type { PipelineSummaryResponseDto } from './dto/pipeline-summary-response.dto';
import type { WorkflowDetailResponseDto } from './dto/workflow-detail-response.dto';
import type { WorkflowExecutionResponseDto } from './dto/workflow-execution-response.dto';
import type { INestApplication } from '@nestjs/common';
import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';
import type { App } from 'supertest/types';

const WORKFLOW_ID = 'b6c1f0d2-3e4a-4b5c-8d6e-7f8091a2b3c4';
const OTHER_TEMPLATE_ID = '7c9e6f21-4b3a-4d5e-8f10-2a3b4c5d6e7f';
const EXECUTION_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const EDITOR_USER: AuthenticatedUser = {
  id: 'b27d9e10-4c3f-4a8b-9f21-6d5e4c3b2a19',
  email: 'editor@unuware.com',
  role: UserRole.EDITOR,
};

/** Respuesta del servicio en el caso feliz, con el HTML ya compilado. */
const EXECUTION_RESULT: WorkflowExecutionResponseDto = {
  executionId: EXECUTION_ID,
  workflowId: WORKFLOW_ID,
  status: ExecutionState.EXITOSO,
  activeCursor: null,
  context: {
    raw_email: { message_id: '<test-msg-001@madridmasd.es>' },
    rendered_html: { compiled_markup: '<h1>Avance Cientifico Notiweb 2026</h1>' },
  },
};

/** Topologia de un solo nodo, compartida por el resumen y el detalle. */
const TOPOLOGY = [
  {
    nodeId: 'trigger_imap',
    nodeType: NodeType.TRIGGER_IMAP,
    outputNamespace: 'raw_email',
  },
];

const WORKFLOW_SUMMARY: PipelineSummaryResponseDto = {
  id: WORKFLOW_ID,
  name: 'Notiweb - publicacion automatica',
  description: null,
  active: false,
  templateId: null,
  topology: TOPOLOGY,
};

/** Detalle CON `params`: es lo que el asistente de edicion hidrata. */
const WORKFLOW_DETAIL: WorkflowDetailResponseDto = {
  ...WORKFLOW_SUMMARY,
  pipelineSchema: {
    flowId: WORKFLOW_ID,
    name: 'Notiweb - publicacion automatica',
    version: '1.0.0',
    entrypoint: 'trigger_imap',
    nodes: {
      trigger_imap: {
        nodeId: 'trigger_imap',
        nodeType: NodeType.TRIGGER_IMAP,
        outputNamespace: 'raw_email',
        nextStep: null,
        onErrorStep: null,
        params: {
          host: 'imap.unuware.com',
          user: 'notiweb@unuware.com',
          passwordEnvKey: 'IMAP_PASSWORD',
        },
      },
    },
  },
};

describe('WorkflowsController (POST /workflows/:id/execute-test)', () => {
  let app: INestApplication;
  let workflowsServiceMock: jest.Mocked<
    Pick<WorkflowsService, 'executeTest' | 'findOneDetail' | 'updateWorkflow'>
  >;
  /** Identidad que el JwtAuthGuard doble inyecta en `req.user` en cada peticion. */
  let currentUser: AuthenticatedUser | undefined;

  beforeAll(async () => {
    // 1. Arrange: app real con el RolesGuard autentico y el JwtAuthGuard
    // sustituido, para aislar la autorizacion de la verificacion del token.
    workflowsServiceMock = {
      executeTest: jest.fn().mockResolvedValue(EXECUTION_RESULT),
      findOneDetail: jest.fn().mockResolvedValue(WORKFLOW_DETAIL),
      updateWorkflow: jest.fn().mockResolvedValue(WORKFLOW_SUMMARY),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [WorkflowsController],
      providers: [
        { provide: WorkflowsService, useValue: workflowsServiceMock },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp: () => {
            getRequest: () => { user?: AuthenticatedUser };
          };
        }) => {
          context.switchToHttp().getRequest().user = currentUser;
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    // El mismo ValidationPipe que monta `main.ts`: sin el, ni el `whitelist` ni
    // el `@IsObject()` del DTO estarian bajo prueba.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    currentUser = EDITOR_USER;
    workflowsServiceMock.executeTest.mockResolvedValue(EXECUTION_RESULT);
    workflowsServiceMock.findOneDetail.mockResolvedValue(WORKFLOW_DETAIL);
    workflowsServiceMock.updateWorkflow.mockResolvedValue(WORKFLOW_SUMMARY);
  });

  const httpServer = (): App => app.getHttpServer() as App;

  describe('1. Contrato del endpoint', () => {
    it('1.1 deberia responder 200 con el checkpoint y el HTML compilado', async () => {
      // 2. Act
      const response = await request(httpServer())
        .post(`/workflows/${WORKFLOW_ID}/execute-test`)
        .send({ mockData: { parsed_email: { clean_title: 'Titular' } } });

      // 3. Assert: 200 y no 201 — el recurso que interesa es el RESULTADO del
      // recorrido, no la fila creada en `ejecuciones_flujo`.
      expect(response.status).toBe(200);
      expect(response.body).toEqual(EXECUTION_RESULT);
      expect(workflowsServiceMock.executeTest).toHaveBeenCalledWith(
        WORKFLOW_ID,
        { mockData: { parsed_email: { clean_title: 'Titular' } } },
      );
    });

    it('1.2 deberia aceptar un cuerpo vacio y delegarlo tal cual', async () => {
      // 2. Act
      const response = await request(httpServer())
        .post(`/workflows/${WORKFLOW_ID}/execute-test`)
        .send({});

      // 3. Assert: `mockData` es opcional; el fixture por defecto lo aplica el
      // servicio, no el controlador.
      expect(response.status).toBe(200);
      expect(workflowsServiceMock.executeTest).toHaveBeenCalledWith(
        WORKFLOW_ID,
        {},
      );
    });

    it('1.3 deberia descartar las propiedades no declaradas en el DTO', async () => {
      // 2. Act
      await request(httpServer())
        .post(`/workflows/${WORKFLOW_ID}/execute-test`)
        .send({ mockData: {}, forzarActivo: true });

      // 3. Assert: el `whitelist` impide colar campos que el DTO no contempla.
      const [, receivedDto] = workflowsServiceMock.executeTest.mock.calls[0];
      expect(receivedDto).not.toHaveProperty('forzarActivo');
    });
  });

  describe('2. Rechazo temprano de entradas invalidas', () => {
    it('2.1 deberia responder 400 si el id no es un UUID', async () => {
      // 2. Act
      const response = await request(httpServer())
        .post('/workflows/no-es-un-uuid/execute-test')
        .send({});

      // 3. Assert: lo corta el ParseUUIDPipe antes de tocar el servicio.
      expect(response.status).toBe(400);
      expect(workflowsServiceMock.executeTest).not.toHaveBeenCalled();
    });

    it('2.2 deberia responder 400 si mockData no es un objeto', async () => {
      // 2. Act
      const response = await request(httpServer())
        .post(`/workflows/${WORKFLOW_ID}/execute-test`)
        .send({ mockData: 'raw_email' });

      // 3. Assert
      expect(response.status).toBe(400);
      expect(workflowsServiceMock.executeTest).not.toHaveBeenCalled();
    });
  });

  describe('3. Propagacion de los fallos del servicio', () => {
    it.each([
      ['404', new NotFoundException('flujo inexistente'), 404],
      ['400', new BadRequestException('esquema no integro'), 400],
      ['409', new ConflictException('ya hay una ejecucion EN_PROCESO'), 409],
    ])(
      '3.x deberia traducir la excepcion del servicio a %s',
      async (_label: string, thrown: Error, expected: number) => {
        // 1. Arrange
        workflowsServiceMock.executeTest.mockRejectedValue(thrown);

        // 2. Act
        const response = await request(httpServer())
          .post(`/workflows/${WORKFLOW_ID}/execute-test`)
          .send({});

        // 3. Assert: el controlador no captura nada; lo traduce el filtro global.
        expect(response.status).toBe(expected);
      },
    );
  });

  describe('3bis. Detalle del flujo (GET /workflows/:id)', () => {
    it('3bis.1 deberia devolver el grafo completo con los params de cada nodo', async () => {
      // 2. Act
      const response = await request(httpServer()).get(
        `/workflows/${WORKFLOW_ID}`,
      );

      // 3. Assert: sin `params` el asistente de edicion no tendria nada que
      // hidratar, y al guardar reescribiria el grafo con el formulario vacio.
      expect(response.status).toBe(200);
      expect(response.body).toEqual(WORKFLOW_DETAIL);
      expect(workflowsServiceMock.findOneDetail).toHaveBeenCalledWith(
        WORKFLOW_ID,
      );
    });

    it('3bis.2 deberia responder 400 si el id no es un UUID', async () => {
      // 2. Act
      const response = await request(httpServer()).get('/workflows/no-es-uuid');

      // 3. Assert
      expect(response.status).toBe(400);
      expect(workflowsServiceMock.findOneDetail).not.toHaveBeenCalled();
    });

    it('3bis.3 deberia traducir a 404 el flujo inexistente', async () => {
      // 1. Arrange
      workflowsServiceMock.findOneDetail.mockRejectedValue(
        new NotFoundException('flujo inexistente'),
      );

      // 2. Act
      const response = await request(httpServer()).get(
        `/workflows/${WORKFLOW_ID}`,
      );

      // 3. Assert
      expect(response.status).toBe(404);
    });

    it('3bis.4 deberia permitir la lectura al rol EDITOR', async () => {
      // 1. Arrange: operar y auditar flujos es competencia del EDITOR
      // (`security-and-scope.md` §2). Sin esto no podria editar un flujo que si
      // puede ejecutar.
      currentUser = EDITOR_USER;

      // 2. Act
      const response = await request(httpServer()).get(
        `/workflows/${WORKFLOW_ID}`,
      );

      // 3. Assert
      expect(response.status).toBe(200);
    });
  });

  describe('3ter. Edicion del grafo (PATCH /workflows/:id)', () => {
    it('3ter.1 deberia aceptar un pipelineSchema completo', async () => {
      // 2. Act
      const response = await request(httpServer())
        .patch(`/workflows/${WORKFLOW_ID}`)
        .send({
          name: 'Notiweb revisado',
          pipelineSchema: WORKFLOW_DETAIL.pipelineSchema,
        });

      // 3. Assert
      expect(response.status).toBe(200);
      expect(workflowsServiceMock.updateWorkflow).toHaveBeenCalledWith(
        WORKFLOW_ID,
        {
          name: 'Notiweb revisado',
          pipelineSchema: WORKFLOW_DETAIL.pipelineSchema,
        },
      );
    });

    it('3ter.2 deberia responder 400 y no 500 ante un description nulo', async () => {
      // 2. Act
      const response = await request(httpServer())
        .patch(`/workflows/${WORKFLOW_ID}`)
        .send({ description: null });

      // 3. Assert: `@IsOptional()` omitia la validacion tambien con `null`, y
      // `whitelist` no descarta una clave declarada, asi que el `null` llegaba
      // al servicio y reventaba en `null.trim()`. `@ValidateIf` lo corta aqui.
      expect(response.status).toBe(400);
      expect(workflowsServiceMock.updateWorkflow).not.toHaveBeenCalled();
    });

    it('3ter.3 deberia seguir aceptando un cambio de estado a secas', async () => {
      // 2. Act
      const response = await request(httpServer())
        .patch(`/workflows/${WORKFLOW_ID}`)
        .send({ active: true });

      // 3. Assert: regresion del contrato existente; `@ValidateIf` no debe
      // exigir los campos de texto cuando estan AUSENTES.
      expect(response.status).toBe(200);
      expect(workflowsServiceMock.updateWorkflow).toHaveBeenCalledWith(
        WORKFLOW_ID,
        { active: true },
      );
    });

    it('3ter.4 NO deberia dejar reescribir la procedencia del flujo', async () => {
      // 2. Act
      await request(httpServer())
        .patch(`/workflows/${WORKFLOW_ID}`)
        .send({ name: 'Notiweb', templateId: OTHER_TEMPLATE_ID });

      // 3. Assert: el maestro del que nacio un flujo es un hecho historico;
      // `UpdateWorkflowDto` no declara el campo y `whitelist` lo descarta.
      const [, receivedDto] = workflowsServiceMock.updateWorkflow.mock.calls[0];
      expect(receivedDto).not.toHaveProperty('templateId');
    });
  });

  describe('4. Autorizacion (PROT-04.2)', () => {
    it('4.1 deberia responder 403 si no se pudo determinar la identidad', async () => {
      // 1. Arrange: el RolesGuard va REAL, asi que sin `req.user` deniega.
      currentUser = undefined;

      // 2. Act
      const response = await request(httpServer())
        .post(`/workflows/${WORKFLOW_ID}/execute-test`)
        .send({});

      // 3. Assert
      expect(response.status).toBe(403);
      expect(workflowsServiceMock.executeTest).not.toHaveBeenCalled();
    });

    it('4.2 deberia permitir el despacho al rol EDITOR', async () => {
      // 1. Arrange: operar y auditar flujos es competencia del EDITOR
      // (`security-and-scope.md` §2); solo las cuentas se reservan al ADMIN.
      currentUser = EDITOR_USER;

      // 2. Act
      const response = await request(httpServer())
        .post(`/workflows/${WORKFLOW_ID}/execute-test`)
        .send({});

      // 3. Assert
      expect(response.status).toBe(200);
    });
  });
});
