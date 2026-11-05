import { BadRequestException } from '@nestjs/common';

import type { SchemaIssueDto } from '@core/fsm/dto/validate-schema-response.dto';
import type { SchemaIssue } from '@core/fsm/validators/pipeline-topology.validator';

/**
 * Cuerpo que `PipelineValidatorService.rejectWith` adjunta a su excepcion.
 *
 * Se tipa aqui porque `BadRequestException.getResponse()` devuelve
 * `string | object`, y sin esta forma la conversion tendria que navegar el
 * cuerpo con asserts sueltos.
 */
interface ValidatorErrorBody {
  readonly issues?: readonly SchemaIssue[];
}

/** Mensaje de reserva cuando un issue llega sin ninguna restriccion asociada. */
const FALLBACK_MESSAGE = 'El campo no supera la validacion del esquema.';

/**
 * Comprueba que el cuerpo de la excepcion traiga el arreglo de issues.
 *
 * El `Array.isArray` va DENTRO de la guarda y no en el llamador: sobre una
 * propiedad `readonly SchemaIssue[]`, `Array.isArray` estrecha a `any[]` y
 * destruye el tipo del elemento, dejando los `map` de abajo con parametros
 * implicitos. Devolviendo el predicado ya con la forma completa, el tipo
 * sobrevive.
 */
const hasIssues = (
  body: unknown,
): body is Required<Pick<ValidatorErrorBody, 'issues'>> =>
  typeof body === 'object' &&
  body !== null &&
  'issues' in body &&
  Array.isArray((body as ValidatorErrorBody).issues);

/**
 * Traduce los issues internos del validador al contrato publico del endpoint.
 *
 * Un `SchemaIssue` agrupa TODAS las reglas rotas de un campo en su arreglo
 * `constraints`. Aqui se DESPLIEGA una por una: el editor JSON dibuja un
 * diagnostico por elemento, y concatenar dos motivos en un solo `message`
 * produciria un tooltip con dos frases pegadas que el usuario no puede separar.
 * La consecuencia esperada es que un campo con dos reglas incumplidas aparezca
 * dos veces en `issues`, con la misma `path` y distinto `message`.
 *
 * Vive fuera del controlador para poder probarse sin montar el modulo HTTP.
 *
 * @param body Cuerpo de la `BadRequestException` lanzada por el validador.
 * @returns Los issues en el contrato publico; vacio si el cuerpo no los trae.
 */
export const toIssueContract = (body: unknown): SchemaIssueDto[] => {
  if (!hasIssues(body)) {
    return [];
  }

  return body.issues.flatMap((issue) => {
    // Un issue sin restricciones no deberia existir, pero llegar aqui con el
    // arreglo vacio lo haria desaparecer del contrato y el campo culpable
    // quedaria sin senalar en el editor.
    if (issue.constraints.length === 0) {
      return [{ path: issue.field, message: FALLBACK_MESSAGE }];
    }

    return issue.constraints.map((message) => ({
      path: issue.field,
      message,
    }));
  });
};

/**
 * Traduce un fallo del validador a la excepcion que el cliente debe recibir.
 *
 * EL PORQUE DE QUE EXISTA: `PipelineValidatorService` lanza sus issues en la
 * forma INTERNA `{ field, code, constraints }`, y hasta ahora solo
 * `FsmController` los traducia. El alta y la edicion de flujos y de plantillas
 * llaman al mismo validador a traves de sus servicios, y como el backend no
 * tiene ningun `ExceptionFilter`, esa forma interna viajaba tal cual al cliente.
 * El editor JSON del frontend lee `issue.path`, que alli no existe: recibia
 * `undefined` y reventaba al resolver la ruta, dejando la vista de plantillas
 * inservible en vez de senalar el campo culpable.
 *
 * Se traduce en el CONTROLADOR y no en el servicio a proposito, manteniendo la
 * decision que ya documentaba `FsmController`: el validador lo comparten cuatro
 * llamadores y cambiar su contrato lo cambiaria para todos a la vez.
 *
 * DEVUELVE la excepcion en vez de lanzarla, y el llamador escribe
 * `throw toIssueContractException(error)`. Una funcion que lanzara por dentro
 * obligaria a TypeScript a deducir que el `catch` no continua, y esa deduccion
 * no cruza la frontera del modulo: los cinco `catch` que la usan fallarian con
 * TS2366 por no terminar en un `return`. Con el `throw` a la vista del
 * compilador el problema no existe, y ademas se lee lo que pasa.
 *
 * Lo que no sea un fallo del validador se devuelve INTACTO: un 500, un conflicto
 * de nombre o un 400 del `ValidationPipe` global sobre el DTO de la peticion no
 * tienen issues que traducir, y envolverlos les quitaria su `message`, que es lo
 * unico que esos errores tienen que decir.
 *
 * @param error Excepcion capturada alrededor de una llamada al validador.
 * @returns La excepcion a relanzar: traducida si traia issues, o la original.
 */
export const toIssueContractException = (error: unknown): unknown => {
  if (!(error instanceof BadRequestException)) {
    return error;
  }

  const issues = toIssueContract(error.getResponse());

  return issues.length > 0
    ? new BadRequestException({ success: false, issues })
    : error;
};
