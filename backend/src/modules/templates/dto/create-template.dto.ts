import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Alta de plantilla (PROT-11.1).
 *
 * No incluye `requiredVariables` ni `createdById` a proposito: la primera la
 * deriva el servicio del propio HTML y la segunda sale del JWT. Aceptarlas por
 * el cuerpo permitiria declarar variables que la plantilla no usa o suplantar
 * la autoria.
 */
export class CreateTemplateDto {
  @ApiProperty({
    description: 'Nombre unico de la plantilla',
    example: 'noticia-basica',
    maxLength: 120,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({
    description: 'Proposito de la plantilla, para el listado administrativo',
    example: 'Cuerpo de noticia con titular y resumen generado por IA',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @ApiProperty({
    description:
      'HTML con variables {{namespace.campo}}. Solo sustitucion determinista: ' +
      'quedan prohibidos los bloques ({{#if}}), los parciales ({{>}}) y el ' +
      'triple-stash ({{{ }}}).',
    example:
      '<h1>{{parsed_email.clean_title}}</h1><p>{{llm_response.summary}}</p>',
  })
  @IsString()
  @IsNotEmpty()
  htmlContent: string;
}
