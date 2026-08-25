import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { PublicIp } from '@common/decorators/public-ip.decorator';

/** Respuesta del healthcheck: sin datos de negocio, apta para exponerse fuera del perimetro. */
interface HealthStatus {
  status: 'ok';
  uptime: number;
}

/**
 * Sonda de vida para el healthcheck del contenedor Docker y la monitorizacion externa.
 * Exenta del filtro de subred (`@PublicIp`) porque el orquestador no vive necesariamente
 * dentro de los rangos corporativos.
 */
@ApiTags('health')
@PublicIp()
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({
    summary: 'Comprueba que la API responde (exenta del filtro de subred)',
  })
  public check(): HealthStatus {
    return { status: 'ok', uptime: process.uptime() };
  }
}
