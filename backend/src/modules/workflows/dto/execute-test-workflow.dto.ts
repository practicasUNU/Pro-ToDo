import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';

/**
 * Namespaces con los que se siembra el contexto cuando la peticion no trae
 * `mockData`.
 *
 * Reproduce la forma con la que `ImapTriggerStrategy` deja un correo en
 * `raw_email`, que es el nodo que el despacho de pruebas omite. Sin este fixture
 * una peticion con cuerpo vacio arrancaria con el contexto a cero y el mapeador
 * fallaria por `missingFields`, que no es el fallo que la prueba busca observar.
 *
 * Las cinco claves son PLANAS y replican una a una las de `ImapTriggerOutput`,
 * incluido que el cuerpo viaje como `text` y no como marcado: el nodo real no
 * emite HTML a proposito (el procesador de IA trabaja sobre texto plano para
 * ahorrar tokens). Anidar aqui los encabezados o anadir un `raw_html` que en
 * produccion no existe haria pasar la prueba a plantillas que luego fallarian
 * con un correo de verdad, que es justo el fallo que este endpoint debe cazar.
 *
 * `raw_email` figura en `ALLOWED_NAMESPACES` de `TemplatesService`, de modo que
 * una plantilla puede interpolar `{{raw_email.subject}}` contra el.
 */
export const DEFAULT_MOCK_NAMESPACES: Record<
  string,
  Record<string, unknown>
> = {
  raw_email: {
    message_id: '<test-msg-001@madridmasd.es>',
    from: 'redaccion@noticias.es',
    subject: 'Avance Cientifico Notiweb 2026',
    text: 'Contenido institucional de prueba para Notiweb.',
    date: '2026-09-08T12:00:00Z',
  },
};

/**
 * Cuerpo del despacho manual de pruebas (`POST /workflows/:id/execute-test`).
 *
 * Es el Camino B de la validacion E2E: ejercita el bucle completo del motor sin
 * depender del listener IMAP, sembrando a mano los namespaces que en produccion
 * produciria el nodo disparador.
 *
 * `@IsObject()` a secas y sin `@ValidateNested()`: la forma de cada namespace la
 * decide el nodo que lo escribe, asi que aqui no hay un contrato que validar. La
 * comprobacion real llega despues, cuando `TemplateRendererService` exige en
 * modo estricto las rutas de `requiredVariables` y devuelve `missingFields`.
 */
export class ExecuteTestWorkflowDto {
  @ApiPropertyOptional({
    description:
      'Mapa de namespaces con el que se siembra el StatePayloadContext. Si se omite, se aplica el fixture estandar de `raw_email`',
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
  readonly mockData?: Record<string, Record<string, unknown>>;
}
