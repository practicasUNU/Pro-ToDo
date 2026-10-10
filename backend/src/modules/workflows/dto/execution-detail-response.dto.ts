import { ApiProperty } from '@nestjs/swagger';

import { ExecutionSummaryResponseDto } from './execution-summary-response.dto';

/**
 * Ejecucion completa, con el checkpoint que permitiria reanudarla.
 *
 * Es la unica respuesta que entrega `contexto_acumulado`: ahi es el dato que se
 * ha pedido, y va una fila por peticion en vez de cincuenta.
 */
export class ExecutionDetailResponseDto extends ExecutionSummaryResponseDto {
  @ApiProperty({
    description:
      'Volcado de `contexto_acumulado`: los namespaces que dejaron los nodos ya ejecutados. Es lo que permite reanudar desde el cursor sin repetir el trabajo previo',
  })
  readonly context: Record<string, Record<string, unknown>>;

  @ApiProperty({
    description:
      'Intentos ya consumidos por nodo. Una reanudacion con `resetRetries` limpia la entrada del cursor y conserva las demas',
  })
  readonly retryState: Record<string, unknown>;
}
