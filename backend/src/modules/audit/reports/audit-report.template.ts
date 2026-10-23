import {
  BRAND_BORDER,
  BRAND_NEGATIVE,
  BRAND_PRIMARY,
  BRAND_PRIMARY_LIGHT,
  BRAND_SURFACE,
  BRAND_TEXT,
  BRAND_TEXT_MUTED,
  FONT_STACK,
  MONO_FONT_STACK,
} from '@common/constants/email-brand.constants';

/**
 * Plantilla Handlebars del informe PDF de auditoria de acciones humanas.
 *
 * Mismas reglas que `TELEMETRY_REPORT_TEMPLATE`: cadena en un modulo TS (para
 * que `nest build` la emita), estilo en linea, sin recursos externos y paleta
 * clara de `email-brand.constants`. Los valores llegan YA formateados y
 * `{{...}}` escapa el HTML de cada campo (correos, ids y nombres de campo).
 */
export const AUDIT_REPORT_TEMPLATE = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Informe de auditoría de acciones</title>
<style>
  @page { size: A4; margin: 18mm 14mm 20mm 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ${FONT_STACK}; color: ${BRAND_TEXT}; font-size: 10px; }
  header { background: linear-gradient(90deg, ${BRAND_PRIMARY} 0%, ${BRAND_PRIMARY_LIGHT} 100%); color: #FFFFFF; padding: 14px 18px; border-radius: 8px; }
  header .brand { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600; }
  header h1 { margin: 4px 0 2px; font-size: 20px; font-weight: 700; }
  header p { margin: 0; font-size: 10px; opacity: 0.9; }
  h2 { font-size: 13px; margin: 18px 0 8px; color: ${BRAND_PRIMARY}; }
  .kpis { display: flex; gap: 8px; margin-top: 14px; }
  .kpi { flex: 1; background: ${BRAND_SURFACE}; border: 1px solid ${BRAND_BORDER}; border-radius: 8px; padding: 10px; }
  .kpi .label { color: ${BRAND_TEXT_MUTED}; font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; }
  .kpi .value { font-size: 15px; font-weight: 700; margin-top: 4px; }
  .filters { color: ${BRAND_TEXT_MUTED}; font-size: 9px; margin-top: 8px; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th { background: ${BRAND_SURFACE}; color: ${BRAND_TEXT_MUTED}; text-align: left; font-weight: 600; font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.04em; }
  th, td { padding: 5px 6px; border-bottom: 1px solid ${BRAND_BORDER}; vertical-align: top; }
  td.mono { font-family: ${MONO_FONT_STACK}; font-size: 8.5px; word-break: break-all; }
  .failed { color: ${BRAND_NEGATIVE}; font-weight: 600; }
  .note { color: ${BRAND_TEXT_MUTED}; font-size: 9px; margin-top: 6px; }
  .empty { color: ${BRAND_TEXT_MUTED}; padding: 12px 0; }
  .signature { margin-top: 26px; display: flex; justify-content: space-between; gap: 24px; page-break-inside: avoid; }
  .signature .block { flex: 1; border-top: 1px solid ${BRAND_TEXT}; padding-top: 6px; }
  .signature .role { color: ${BRAND_TEXT_MUTED}; font-size: 9px; }
</style>
</head>
<body>
  <header>
    <div class="brand">UNUWARE · Proto-Do</div>
    <h1>Informe de auditoría de acciones</h1>
    <p>Periodo: {{rangeLabel}} · Emitido el {{issuedAt}}</p>
  </header>

  <section class="kpis">
    {{#each kpis}}
    <div class="kpi"><div class="label">{{label}}</div><div class="value">{{value}}</div></div>
    {{/each}}
  </section>
  {{#if filtersLabel}}<p class="filters">Filtros aplicados: {{filtersLabel}}</p>{{/if}}

  <h2>Detalle de eventos</h2>
  {{#if items.length}}
  <table>
    <thead>
      <tr>
        <th>Fecha</th><th>Usuario</th><th>Acción</th><th>Tabla</th>
        <th>Registro</th><th>IP</th><th>Campos modificados</th>
      </tr>
    </thead>
    <tbody>
      {{#each items}}
      <tr>
        <td>{{createdAt}}</td><td>{{user}}</td>
        <td>{{#if isFailure}}<span class="failed">{{action}}</span>{{else}}{{action}}{{/if}}</td>
        <td>{{table}}</td><td class="mono">{{recordId}}</td><td class="mono">{{sourceIp}}</td>
        <td class="mono">{{changedKeys}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>
  {{#if truncatedNote}}<p class="note">{{truncatedNote}}</p>{{/if}}
  <p class="note">Los valores anteriores y nuevos de cada evento figuran íntegros en la exportación CSV.</p>
  {{else}}
  <p class="empty">No hay eventos de auditoría en el periodo.</p>
  {{/if}}

  <section class="signature">
    <div class="block">
      <strong>Generado por</strong><br>{{requestedBy}}
      <div class="role">Proto-Do · Plataforma de automatización UNUWARE</div>
    </div>
    <div class="block">
      <strong>Validación institucional</strong><br>&nbsp;
      <div class="role">Firma y sello del responsable de UNUWARE</div>
    </div>
  </section>
</body>
</html>`;
