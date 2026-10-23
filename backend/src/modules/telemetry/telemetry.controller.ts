import {
  Controller,
  Get,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import {
  TelemetryHistoryQueryDto,
  TelemetryQueryDto,
} from '@modules/telemetry/dto/telemetry-query.dto';
import {
  ModelBreakdownResponseDto,
  TelemetryHistoryPageResponseDto,
  TelemetrySummaryResponseDto,
} from '@modules/telemetry/dto/telemetry-report-response.dto';
import { buildTelemetryCsv } from '@modules/telemetry/reports/telemetry-csv.builder';
import { TelemetryPdfRenderer } from '@modules/telemetry/reports/telemetry-pdf.renderer';
import { TelemetryQueryService } from '@modules/telemetry/telemetry-query.service';
import { UserRole } from '@modules/users/enums/user-role.enum';

import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';

/** Nombres de descarga fijos: los pide asi el contrato con la interfaz. */
export const CSV_FILENAME = 'informe-telemetria.csv';
export const PDF_FILENAME = 'informe-telemetria.pdf';

/**
 * Consumo de IA: agregados para el dashboard y exportaciones CSV/PDF.
 *
 * ADMIN y EDITOR, igual que `/executions`: el editor audita flujos
 * (`security-and-scope.md` §2) y su coste es parte de esa auditoria. Los guards
 * van a nivel de clase para que ningun endpoint futuro quede abierto por
 * olvido.
 */
@ApiTags('telemetry')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, expirado o invalido' })
@ApiForbiddenResponse({ description: 'IP fuera de la red corporativa' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.EDITOR)
@Controller('telemetry')
export class TelemetryController {
  constructor(
    private readonly telemetryQueryService: TelemetryQueryService,
    private readonly pdfRenderer: TelemetryPdfRenderer,
  ) {}

  @Get('summary')
  @ApiOperation({ summary: 'KPIs globales de coste, tokens y exito del rango' })
  @ApiOkResponse({ type: TelemetrySummaryResponseDto })
  public async getSummary(
    @Query() query: TelemetryQueryDto,
  ): Promise<TelemetrySummaryResponseDto> {
    return this.telemetryQueryService.getSummary(query);
  }

  @Get('breakdown-by-model')
  @ApiOperation({ summary: 'Consumo agregado por proveedor y modelo' })
  @ApiOkResponse({ type: [ModelBreakdownResponseDto] })
  public async getBreakdownByModel(
    @Query() query: TelemetryQueryDto,
  ): Promise<ModelBreakdownResponseDto[]> {
    return this.telemetryQueryService.getBreakdownByModel(query);
  }

  @Get('history')
  @ApiOperation({ summary: 'Inferencias registradas, paginadas' })
  @ApiOkResponse({ type: TelemetryHistoryPageResponseDto })
  public async getHistory(
    @Query() query: TelemetryHistoryQueryDto,
  ): Promise<TelemetryHistoryPageResponseDto> {
    return this.telemetryQueryService.getHistory(query);
  }

  @Get('export/csv')
  @ApiOperation({ summary: 'Descarga el consumo del rango en CSV' })
  @ApiProduces('text/csv')
  public async exportCsv(
    @Query() query: TelemetryQueryDto,
  ): Promise<StreamableFile> {
    const { items } = await this.telemetryQueryService.getExportRows(query);

    return new StreamableFile(buildTelemetryCsv(items), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename=${CSV_FILENAME}`,
    });
  }

  @Get('export/pdf')
  @ApiOperation({
    summary:
      'Descarga el informe PDF con totales, desglose y detalle del rango',
  })
  @ApiProduces('application/pdf')
  public async exportPdf(
    @Query() query: TelemetryQueryDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<StreamableFile> {
    // Secuencial y no en paralelo: comparten el pool de PostgreSQL con el
    // motor, y un informe no debe ocupar tres conexiones a la vez.
    const summary = await this.telemetryQueryService.getSummary(query);
    const breakdown =
      await this.telemetryQueryService.getBreakdownByModel(query);
    const { range, items, truncated } =
      await this.telemetryQueryService.getExportRows(query);

    const pdf = await this.pdfRenderer.render({
      range,
      summary,
      breakdown,
      items,
      truncated,
      requestedBy: currentUser.email,
    });

    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `attachment; filename=${PDF_FILENAME}`,
    });
  }
}
