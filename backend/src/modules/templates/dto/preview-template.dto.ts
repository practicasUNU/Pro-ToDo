import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';

/**
 * Payload simulado para previsualizar una plantilla (PROT-11.1).
 *
 * Todo es opcional: sin `samplePayload`, el servicio genera marcadores a partir
 * de `requiredVariables`, de modo que la vista previa nunca falla por falta de
 * datos y el editor ve la maqueta con solo abrir el dialogo.
 */
export class PreviewTemplateDto {
  @ApiPropertyOptional({
    description:
      'Namespaces simulados con los que compilar. Se fusionan sobre los marcadores autogenerados.',
    example: { parsed_email: { clean_title: 'Innovacion en Madrid' } },
  })
  @IsOptional()
  @IsObject()
  samplePayload?: Record<string, Record<string, unknown>>;
}
