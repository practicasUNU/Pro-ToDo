import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsObject, IsOptional } from 'class-validator';

/**
 * Cuerpo de `POST /api/executions/:id/resume`: reintento manual de CU-09.
 *
 * Los dos campos son opcionales y el cuerpo vacio (`{}`) ya rinde la
 * reanudacion mas comun: retomar el flujo desde el nodo que lo detuvo, con su
 * presupuesto de reintentos restaurado.
 */
export class ResumeExecutionDto {
  @ApiPropertyOptional({
    description:
      'Devuelve al nodo del cursor su presupuesto de reintentos completo. Por defecto TRUE: la fila pausada llega con su contador en el tope, asi que sin esto reanudar concederia un unico intento en vez de la politica que declara el nodo',
    default: true,
  })
  @IsOptional()
  @IsBoolean({ message: 'resetRetries debe ser un booleano.' })
  readonly resetRetries?: boolean;

  @ApiPropertyOptional({
    description:
      'Namespaces a fusionar sobre el contexto acumulado antes de reanudar. El caso tipico de CU-09 es que faltase un campo: parchearlo convierte la reanudacion en un arreglo y no en una repeticion del mismo fallo. La fusion es por namespace, de modo que parchear un campo no borra los demas',
    example: { parsed_email: { clean_title: 'Titulo corregido a mano' } },
  })
  @IsOptional()
  @IsObject({ message: 'contextPatch debe ser un objeto de namespaces.' })
  readonly contextPatch?: Record<string, Record<string, unknown>>;
}
