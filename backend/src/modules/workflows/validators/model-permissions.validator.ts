import { ForbiddenException } from '@nestjs/common';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { UserRole } from '@modules/users/enums/user-role.enum';

import type { PipelineSchema } from '@core/fsm/types/pipeline-schema.types';

/**
 * Nodos cuyo `params.model` nombra un modelo de lenguaje facturable.
 *
 * Es una lista explicita y no "todo nodo que tenga un `model`": otros nodos
 * podrian llamar `model` a cualquier otra cosa, y una comprobacion que
 * adivinase por el nombre del campo prohibiria configuraciones que no gastan
 * un euro. Un nodo nuevo que consuma un LLM se anade aqui.
 */
const BILLABLE_MODEL_NODE_TYPES: ReadonlySet<NodeType> = new Set([
  NodeType.PROCESADOR_IA,
  NodeType.PROCESADOR_OCR,
]);

/**
 * Impide que un rol insuficiente guarde un flujo con un modelo de pago.
 *
 * POR QUE AQUI Y NO EN EL VALIDADOR DE ESQUEMAS. `PipelineValidatorService` no
 * sabe nada del actor, y no deberia: comprueba que el grafo sea coherente, algo
 * que no depende de quien lo escriba. Meter una regla de autorizacion ahi
 * convertiria un 403 —"no puedes hacer esto"— en un 400 con contrato de
 * `issues[]` —"esto esta mal escrito"—, que es un diagnostico distinto y lleva
 * al operador a buscar un error de sintaxis que no existe.
 *
 * NO ES LA UNICA BARRERA NI PRETENDE SERLO. La interfaz deshabilita las
 * opciones restringidas con el `minRoleRequired` del catalogo, pero eso es
 * comodidad: el cliente se puede saltar. Esta funcion es la que decide.
 *
 * Cubre los tres caminos del asistente sin esfuerzo adicional: no existe un
 * endpoint de borrador en el backend, el borrador del asistente se guarda por
 * los mismos `POST /workflows` y `PATCH /workflows/:id`.
 *
 * @param schema Esquema ya deserializado que se pretende guardar.
 * @param userRole Rol del autor, tomado del JWT y nunca del cuerpo.
 * @throws ForbiddenException nombrando el nodo y el modelo concretos.
 */
export const assertModelPermissions = (
  schema: PipelineSchema,
  userRole: UserRole,
  adminOnlyModels: ReadonlySet<string>,
): void => {
  // Cláusula de guarda: un ADMIN puede usar cualquier modelo del catalogo.
  if (userRole === UserRole.ADMIN) {
    return;
  }

  for (const [nodeId, node] of Object.entries(schema.nodes)) {
    if (!BILLABLE_MODEL_NODE_TYPES.has(node.nodeType)) {
      continue;
    }

    const model = node.params.model;

    if (typeof model !== 'string' || !adminOnlyModels.has(model)) {
      continue;
    }

    // El mensaje NOMBRA el nodo y el modelo a proposito. Un 403 generico sobre
    // un pipeline de ocho pasos obliga a revisarlos uno a uno para averiguar
    // cual es el que sobra.
    throw new ForbiddenException(
      `El modelo "${model}" del paso "${nodeId}" (${node.nodeType}) esta reservado al rol ADMIN ` +
        'por ser de pago. Elige un modelo gratuito o pide a un administrador que guarde el flujo.',
    );
  }
};
