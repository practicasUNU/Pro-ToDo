import { Injectable } from '@nestjs/common';
import Handlebars from 'handlebars';

import { renderHtmlToPdf } from '@common/utils/html-to-pdf.util';
import { AuditActionType } from '@modules/audit/enums/audit-action.enum';
import { AUDIT_REPORT_TEMPLATE } from '@modules/audit/reports/audit-report.template';
import {
  changedAuditPaths,
  labelAuditAction,
  labelAuditTable,
} from '@modules/audit/reports/audit-labels';
import { BrowserPoolService } from '@modules/nodes/services/browser-pool.service';

import type { DateRange } from '@common/utils/date-range.util';
import type { AuditEventResponseDto } from '@modules/audit/dto/audit-event-response.dto';
import type { AuditEventsFilterDto } from '@modules/audit/dto/list-audit-events-query.dto';

/**
 * Filas del detalle que caben en el PDF, mismo criterio que la telemetria: el
 * volcado completo es el CSV y el PDF avisa cuando recorta.
 */
export const MAX_AUDIT_PDF_ROWS = 2_000;

/** Zona en la que se leen las fechas del informe: la de la organizacion. */
const REPORT_TIME_ZONE = 'Europe/Madrid';

/** Texto de la celda cuando no consta el dato. */
const EMPTY_VALUE = '—';

/** Todo lo que el informe necesita, ya consultado. */
export interface AuditPdfInput {
  readonly range: DateRange;
  readonly filters: AuditEventsFilterDto;
  /** Correo del usuario filtrado, si lo hay (el filtro llega como UUID). */
  readonly filteredUserEmail?: string | null;
  readonly items: readonly AuditEventResponseDto[];
  /** Si la consulta ya se corto en `MAX_AUDIT_EXPORT_ROWS`. */
  readonly truncated: boolean;
  /** Correo de quien pide el informe, para el bloque de firma. */
  readonly requestedBy: string;
}

const integerFormat = new Intl.NumberFormat('es-ES');
const dateTimeFormat = new Intl.DateTimeFormat('es-ES', {
  dateStyle: 'short',
  timeStyle: 'medium',
  timeZone: REPORT_TIME_ZONE,
});
const dateFormat = new Intl.DateTimeFormat('es-ES', {
  dateStyle: 'long',
  timeZone: REPORT_TIME_ZONE,
});

const countBy = (
  items: readonly AuditEventResponseDto[],
  actions: readonly AuditActionType[],
): number => items.filter((item) => actions.includes(item.action)).length;

/**
 * Genera el informe PDF de auditoria con el Chromium compartido. Solo lista
 * los CAMPOS modificados de cada evento: los valores completos (que pueden ser
 * plantillas HTML enteras) van en el CSV.
 */
@Injectable()
export class AuditPdfRenderer {
  /** Instancia AISLADA de Handlebars, como en `TelemetryPdfRenderer`. */
  private readonly template = Handlebars.create().compile(
    AUDIT_REPORT_TEMPLATE,
    { strict: true },
  );

  constructor(private readonly browserPool: BrowserPoolService) {}

  /** HTML del informe. Publico para poder probarlo sin navegador. */
  public renderHtml(input: AuditPdfInput, issuedAt = new Date()): string {
    const items = input.items.slice(0, MAX_AUDIT_PDF_ROWS);
    const omitted = input.items.length - items.length;

    return this.template({
      rangeLabel: `${dateFormat.format(input.range.from)} – ${dateFormat.format(
        // El fin es exclusivo: se muestra el ultimo instante incluido.
        new Date(input.range.to.getTime() - 1),
      )}`,
      issuedAt: dateTimeFormat.format(issuedAt),
      kpis: [
        {
          label: 'Eventos',
          value: integerFormat.format(input.items.length),
        },
        {
          label: 'Cambios de datos',
          value: integerFormat.format(
            countBy(input.items, [
              AuditActionType.CREATE,
              AuditActionType.UPDATE,
              AuditActionType.DELETE,
              AuditActionType.ROLE_CHANGE,
            ]),
          ),
        },
        {
          label: 'Inicios de sesión',
          value: integerFormat.format(
            countBy(input.items, [AuditActionType.LOGIN]),
          ),
        },
        {
          label: 'Accesos fallidos',
          value: integerFormat.format(
            countBy(input.items, [AuditActionType.LOGIN_FAILED]),
          ),
        },
      ],
      filtersLabel: this.describeFilters(input),
      items: items.map((item) => ({
        createdAt: dateTimeFormat.format(new Date(item.createdAt)),
        user: item.userEmail ?? item.userId ?? EMPTY_VALUE,
        action: labelAuditAction(item.action),
        isFailure: item.action === AuditActionType.LOGIN_FAILED,
        table: labelAuditTable(item.affectedTable),
        recordId: item.recordId ?? EMPTY_VALUE,
        sourceIp: item.sourceIp ?? EMPTY_VALUE,
        changedKeys:
          changedAuditPaths(item.previousData, item.newData).join(', ') ||
          EMPTY_VALUE,
      })),
      truncatedNote:
        omitted > 0 || input.truncated
          ? `El detalle muestra los ${integerFormat.format(items.length)} eventos más recientes del periodo; el detalle íntegro está en la exportación CSV.`
          : '',
      requestedBy: input.requestedBy,
    });
  }

  /** PDF A4 del informe. El contexto de Chromium se cierra siempre. */
  public async render(input: AuditPdfInput): Promise<Buffer> {
    return renderHtmlToPdf(this.browserPool, this.renderHtml(input));
  }

  private describeFilters(input: AuditPdfInput): string {
    const { filters } = input;
    const parts = [
      filters.userId !== undefined
        ? `usuario ${input.filteredUserEmail ?? filters.userId}`
        : null,
      filters.action !== undefined
        ? `acción ${labelAuditAction(filters.action)}`
        : null,
      filters.affectedTable !== undefined
        ? `tabla ${labelAuditTable(filters.affectedTable)}`
        : null,
    ].filter((part): part is string => part !== null);

    return parts.join(' · ');
  }
}
