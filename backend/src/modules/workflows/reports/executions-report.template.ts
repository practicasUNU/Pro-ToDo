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
 * Plantilla Handlebars del informe PDF del historial de ejecuciones.
 *
 * Mismas reglas que `TELEMETRY_REPORT_TEMPLATE` y `AUDIT_REPORT_TEMPLATE`:
 * cadena en un modulo TS (para que `nest build` la emita), estilo en linea, sin
 * recursos externos y paleta clara de `email-brand.constants`. Los valores
 * llegan YA formateados desde `ExecutionsPdfRenderer` y `{{...}}` escapa el
 * HTML de cada campo: el nombre del flujo y el motivo los escribe una persona.
 */
export const EXECUTIONS_REPORT_TEMPLATE = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Historial de ejecuciones</title>
<style>
  @page { size: A4; margin: 18mm 14mm 20mm 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ${FONT_STACK}; color: ${BRAND_TEXT}; font-size: 10px; }
  header { background: linear-gradient(90deg, ${BRAND_PRIMARY} 0%, ${BRAND_PRIMARY_LIGHT} 100%); color: #FFFFFF; padding: 14px 18px; border-radius: 8px; }
  header .brand { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600; }
  header h1 { margin: 4px 0 2px; font-size: 20px; font-weight: 700; }
  header p { margin: 0; font-size: 10px; opacity: 0.9; }
  h2 { font-size: 13px; margin: 18px 0 8px; color: ${BRAND_PRIMARY}; }
  .filters { margin: 10px 0 0; padding: 0; list-style: none; color: ${BRAND_TEXT_MUTED}; font-size: 9px; }
  .filters li { display: inline; }
  .filters li + li::before { content: " · "; }
  .filters strong { color: ${BRAND_TEXT}; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th { background: ${BRAND_SURFACE}; color: ${BRAND_TEXT_MUTED}; text-align: left; font-weight: 600; font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.04em; }
  th, td { padding: 5px 6px; border-bottom: 1px solid ${BRAND_BORDER}; vertical-align: top; }
  td.mono { font-family: ${MONO_FONT_STACK}; font-size: 8px; word-break: break-all; }
  td.nowrap { white-space: nowrap; }
  .alert { color: ${BRAND_NEGATIVE}; font-weight: 600; }
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
    <h1>Historial de ejecuciones</h1>
    <p>Periodo: {{periodLabel}} · Emitido el {{issuedAt}}</p>
  </header>

  <ul class="filters">
    {{#each filters}}<li><strong>{{label}}:</strong> {{value}}</li>{{/each}}
  </ul>

  <h2>Ejecuciones ({{rowCount}})</h2>
  {{#if items.length}}
  <table>
    <thead>
      <tr>
        <th>Ejecución</th><th>Flujo</th><th>ID flujo</th><th>Estado</th><th>Inicio</th>
        <th>Última actualización</th><th>Paso actual</th><th>Alertas</th><th>Motivo</th>
      </tr>
    </thead>
    <tbody>
      {{#each items}}
      <tr>
        <td class="mono">{{executionId}}</td><td>{{flowName}}</td><td class="mono">{{flowId}}</td>
        <td>{{state}}</td><td class="nowrap">{{startedAt}}</td><td class="nowrap">{{updatedAt}}</td>
        <td class="mono">{{activeCursor}}</td>
        <td>{{#if hasAlerts}}<span class="alert">Sí</span>{{else}}No{{/if}}</td>
        <td>{{failureReason}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>
  {{#if truncatedNote}}<p class="note">{{truncatedNote}}</p>{{/if}}
  {{else}}
  <p class="empty">No hay ejecuciones que cumplan los filtros aplicados.</p>
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
