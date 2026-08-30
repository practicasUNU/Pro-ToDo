import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { PublicIp } from '@common/decorators/public-ip.decorator';
import { PipelineSchemaDto } from '@core/fsm/dto/pipeline-schema.dto';
import { PipelineValidatorService } from '@core/fsm/services/pipeline-validator.service';

/**
 * Superficie HTTP del motor FSM.
 *
 * TODO(PROT-08): `@PublicIp()` es TEMPORAL, solo para poder ejercitar el
 * validador desde Postman durante el desarrollo. Deja la ruta accesible sin
 * token y desde cualquier IP: el unico guard global es `IpWhitelistGuard`, que
 * es justo del que exime, `JwtAuthGuard` no es global y `RedLocalMiddleware`
 * solo cubre las rutas de Swagger (ver `main.ts`). Retirar el decorador y
 * anadir `@UseGuards(JwtAuthGuard, RolesGuard)` antes de cualquier despliegue.
 *
 * Mitigacion mientras tanto: el endpoint no lee ni escribe en base de datos,
 * solo valida un JSON en memoria y lo devuelve.
 */
@ApiTags('FSM')
@PublicIp()
@Controller('fsm')
export class FsmController {
  constructor(
    private readonly pipelineValidatorService: PipelineValidatorService,
  ) {}

  /**
   * Valida un `pipeline_schema` sin persistirlo.
   *
   * El `ValidationPipe` global no interfiere: `unknown` emite `Object` como
   * metatipo y `ValidationPipe.toValidate()` descarta ese tipo, asi que el
   * cuerpo llega intacto. Es imprescindible, porque el servicio necesita ver
   * las propiedades no declaradas para rechazarlas.
   */
  @Post('validate-schema')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Valida la forma, los tipos y la topologia de un pipeline_schema',
  })
  @ApiBody({ type: PipelineSchemaDto })
  @ApiOkResponse({
    description: 'El esquema es integro; se devuelve ya validado',
    type: PipelineSchemaDto,
  })
  @ApiBadRequestResponse({
    description:
      'Esquema invalido: { statusCode, error: "PIPELINE_SCHEMA_INVALIDO", message, issues[] }',
  })
  public async validateSchema(
    @Body() rawJson: unknown,
  ): Promise<PipelineSchemaDto> {
    return this.pipelineValidatorService.validateSchema(rawJson);
  }
}
