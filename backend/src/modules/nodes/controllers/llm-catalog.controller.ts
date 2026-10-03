import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import {
  LlmModelDescriptor,
  LlmTestConnectionDto,
  LlmTestConnectionResponseDto,
} from '@modules/nodes/dto/llm-catalog.dto';
import { LlmProviderCatalogService } from '@modules/nodes/services/llm-provider-catalog.service';
import { UserRole } from '@modules/users/enums/user-role.enum';

/**
 * Validacion estricta del cuerpo, igual que en `WizardController`.
 *
 * MATIZ IMPORTANTE sobre su alcance real: los pipes globales corren ANTES que
 * los de parametro, y el de `main.ts` ya lleva `whitelist: true`. Cuando este
 * recibe el cuerpo, los campos desconocidos YA han sido descartados, asi que
 * `forbidNonWhitelisted` no llega a rechazar nada y un `prompt` colado produce
 * un 200 con el cuerpo depurado, no un 400.
 *
 * Se declara igualmente porque lo que de verdad importa aqui esta garantizado
 * por cualquiera de las dos vias: que el texto enviado al proveedor —y por
 * tanto el coste de la llamada— no lo pueda decidir el cliente. Y si algun dia
 * el pipe global pierde su `whitelist`, este sigue cubriendo el endpoint.
 */
const STRICT_VALIDATION = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

/**
 * Catalogo de modelos de lenguaje y banco de pruebas (`/api/llm`).
 *
 * Vive en `NodesModule` y no en `WizardModule`, aunque la prueba de conexion
 * sea hermana de `check-imap` y `check-scraper`: los clientes de LLM son
 * providers de este modulo y no estan exportados. Llevarse el endpoint al
 * asistente obligaria a exportarlos y a que `WizardModule` importase
 * `NodesModule`, algo que ese modulo evita a proposito —solo consume DTOs y
 * funciones puras por import directo—. El patron de respuesta si se reutiliza
 * tal cual.
 *
 * Los dos endpoints comparten guards de clase (ADMIN y EDITOR) para que
 * ninguno futuro quede desprotegido por olvido. Que el EDITOR pueda probar la
 * conexion es deliberado: configurar flujos es justo su competencia segun
 * `security-and-scope.md` §2, y sin esto no podria verificar lo que acaba de
 * rellenar.
 */
@ApiTags('llm')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, expirado o invalido' })
@ApiForbiddenResponse({
  description: 'IP fuera de la red corporativa o rol distinto de ADMIN/EDITOR',
})
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.EDITOR)
@Controller('llm')
export class LlmCatalogController {
  constructor(
    private readonly llmProviderCatalogService: LlmProviderCatalogService,
  ) {}

  @Get('models')
  @ApiOperation({
    summary: 'Lista los modelos de lenguaje y su disponibilidad real',
    description:
      'La disponibilidad se recalcula en cada peticion leyendo el entorno, de modo que una ' +
      'credencial anadida se nota al recargar el asistente y no al siguiente despliegue.',
  })
  @ApiOkResponse({ type: [LlmModelDescriptor] })
  public getModels(): LlmModelDescriptor[] {
    return this.llmProviderCatalogService.getAvailableModels();
  }

  /**
   * Prueba de conectividad.
   *
   * `@HttpCode(OK)` sobre un `@Post` porque no se crea nada: la peticion es un
   * POST por el cuerpo que lleva, no por su semantica. Y un fallo del
   * proveedor sale como 200 con `success: false`, nunca como 4xx o 5xx: que la
   * conexion falle es el resultado que esta operacion viene a averiguar.
   */
  @Post('test-connection')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Ejecuta una inferencia minima contra un proveedor y mide la latencia',
    description:
      'AVISO: contra un proveedor de pago, cada llamada factura tokens. El prompt lo fija el ' +
      'backend y no se puede sustituir desde el cliente. Revisa `isMock` en la respuesta: si ' +
      'sale true, respondio el simulador porque falta la credencial, no el proveedor real.',
  })
  @ApiOkResponse({ type: LlmTestConnectionResponseDto })
  @ApiBadRequestResponse({
    description: 'El cuerpo no supera la validacion del DTO',
  })
  public async testConnection(
    @Body(STRICT_VALIDATION) llmTestConnectionDto: LlmTestConnectionDto,
  ): Promise<LlmTestConnectionResponseDto> {
    return this.llmProviderCatalogService.testConnection(llmTestConnectionDto);
  }
}
