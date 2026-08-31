import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { RolesGuard } from '@common/guards/roles.guard';
import { PipelineSchemaDto } from '@core/fsm/dto/pipeline-schema.dto';
import { PipelineValidatorService } from '@core/fsm/services/pipeline-validator.service';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';

/**
 * Superficie HTTP del motor FSM.
 *
 * Doble barrera, igual que `AuthController`: al no llevar `@PublicIp()`, la ruta
 * queda bajo el `IpWhitelistGuard` global (perimetro corporativo, PROT-05) y
 * ademas exige un JWT valido. El `@PublicIp()` temporal que PROT-08 dejo aqui
 * para ejercitar el validador desde Postman se retiro en PROT-10.
 *
 * Sin `@Roles(...)`: `RolesGuard` deja pasar cuando no hay metadata de roles, de
 * modo que basta con estar autenticado. Es lo correcto segun
 * `security-and-scope.md` §2 — configurar y auditar flujos es competencia del
 * rol EDITOR, no solo del ADMIN.
 */
@ApiTags('FSM')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, expirado o invalido' })
@UseGuards(JwtAuthGuard, RolesGuard)
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
