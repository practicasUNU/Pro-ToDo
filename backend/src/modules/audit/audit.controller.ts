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
import { AuditEventPageResponseDto } from '@modules/audit/dto/audit-event-response.dto';
import {
  ExportAuditReportQueryDto,
  ListAuditEventsQueryDto,
} from '@modules/audit/dto/list-audit-events-query.dto';
import { buildAuditCsv } from '@modules/audit/reports/audit-csv.builder';
import { AuditPdfRenderer } from '@modules/audit/reports/audit-pdf.renderer';
import { AuditLoggerService } from '@modules/audit/services/audit-logger.service';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { UserRole } from '@modules/users/enums/user-role.enum';

import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';

/** Nombres de descarga fijos: los pide asi el contrato con la interfaz. */
export const AUDIT_CSV_FILENAME = 'informe-auditoria.csv';
export const AUDIT_PDF_FILENAME = 'informe-auditoria.pdf';

/**
 * Historial de acciones humanas (logins, cambios de rol y mutaciones CRUD) y
 * sus informes.
 *
 * SOLO ADMIN: incluye la gestion de cuentas y los accesos fallidos, que son
 * del ambito exclusivo del administrador (`security-and-scope.md` §2). Guards
 * a nivel de clase para que ningun endpoint futuro quede abierto por olvido.
 */
@ApiTags('audit')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, expirado o invalido' })
@ApiForbiddenResponse({
  description: 'IP fuera de la red corporativa o rol distinto de ADMIN',
})
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('audit')
export class AuditController {
  constructor(
    private readonly auditLogger: AuditLoggerService,
    private readonly pdfRenderer: AuditPdfRenderer,
  ) {}

  @Get('events')
  @ApiOperation({ summary: 'Eventos de auditoria filtrados y paginados' })
  @ApiOkResponse({ type: AuditEventPageResponseDto })
  public async findEvents(
    @Query() query: ListAuditEventsQueryDto,
  ): Promise<AuditEventPageResponseDto> {
    return this.auditLogger.findPage(query);
  }

  @Get('reports/export')
  @ApiOperation({ summary: 'Descarga el informe de auditoria en CSV o PDF' })
  @ApiProduces('text/csv', 'application/pdf')
  public async exportReport(
    @Query() query: ExportAuditReportQueryDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<StreamableFile> {
    const { format, ...filters } = query;
    const { range, items, truncated } =
      await this.auditLogger.getExportRows(filters);

    if (format === 'csv') {
      return new StreamableFile(buildAuditCsv(items), {
        type: 'text/csv; charset=utf-8',
        disposition: `attachment; filename=${AUDIT_CSV_FILENAME}`,
      });
    }

    const pdf = await this.pdfRenderer.render({
      range,
      filters,
      filteredUserEmail:
        filters.userId === undefined
          ? null
          : (items.find((item) => item.userId === filters.userId)?.userEmail ??
            null),
      items,
      truncated,
      requestedBy: currentUser.email,
    });

    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `attachment; filename=${AUDIT_PDF_FILENAME}`,
    });
  }
}
