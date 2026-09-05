import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';

/**
 * Cuerpo del despacho manual (`POST /workflows/:id/run-test`).
 *
 * Es el Camino B de la validacion E2E: permite ejercitar el bucle completo del
 * motor sin depender del listener IMAP, sembrando a mano los namespaces que en
 * produccion produciria el nodo disparador.
 *
 * `@IsObject()` a secas y sin `@ValidateNested()`: la forma de cada namespace la
 * decide el nodo que lo escribe, asi que aqui no hay un contrato que validar. La
 * comprobacion real llega despues, cuando `TemplateRendererService` exige en
 * modo estricto las rutas de `requiredVariables` y devuelve `missingFields`.
 */
export class RunWorkflowTestDto {
  @ApiPropertyOptional({
    description:
      'Namespaces iniciales con los que se siembra el StatePayloadContext',
    example: {
      parsed_email: {
        clean_title: 'Noticia de Prueba',
        description: 'Bajada de la noticia',
        clean_body: 'Contenido extenso redactado...',
        image_path: '2026/09/laboratorio.jpg',
      },
    },
  })
  @IsOptional()
  @IsObject()
  readonly initialPayload?: Record<string, Record<string, unknown>>;
}
