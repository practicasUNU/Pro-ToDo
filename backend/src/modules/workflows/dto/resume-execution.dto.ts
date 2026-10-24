import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsObject, IsOptional, IsString } from 'class-validator';

import { TrimmedString } from '@common/decorators/trimmed-string.decorator';

/**
 * Cuerpo de `POST /api/executions/:id/resume`: reintento manual de CU-09.
 *
 * Los tres campos son opcionales y el cuerpo vacio (`{}`) ya rinde la
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

  @ApiPropertyOptional({
    description:
      'Paso desde el que reanudar, si no es el que detuvo la ejecucion. Solo se admite el propio cursor o un nodo que YA se ejecuto —su namespace esta en el contexto acumulado—: saltar a un paso posterior dejaria sin escribir los namespaces intermedios y el flujo reventaria al interpolarlos',
    example: 'procesador_ia',
  })
  @IsOptional()
  @TrimmedString()
  @IsString({ message: 'targetStepId debe ser el identificador de un nodo.' })
  readonly targetStepId?: string;
}
