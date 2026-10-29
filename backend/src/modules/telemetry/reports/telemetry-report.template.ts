import {
  BRAND_BORDER,
  BRAND_PRIMARY,
  BRAND_PRIMARY_LIGHT,
  BRAND_SURFACE,
  BRAND_TEXT,
  BRAND_TEXT_MUTED,
  BRAND_WARNING,
  FONT_STACK,
  MONO_FONT_STACK,
} from '@common/constants/email-brand.constants';

/**
 * Plantilla Handlebars del informe PDF de telemetria.
 *
 * Vive como cadena en un modulo TypeScript y no como `.hbs` suelto porque
 * `nest build` solo emite lo que compila `tsc`: un fichero de plantilla
 * necesitaria declarar `assets` en `nest-cli.json` y, el dia que alguien lo
 * olvide, el informe fallaria solo en produccion.
 *
 * TODO el estilo va en linea y sin recursos externos: el PDF se renderiza con
 * `page.setContent` y el proyecto no hace peticiones a terceros (ni CDN de
 * fuentes). La paleta es la de las cartas de correo (`email-brand.constants`),
 * que replica el modo claro de `app.scss`: un PDF se imprime sobre papel blanco.
 *
 * Los valores llegan YA formateados desde `TelemetryPdfRenderer`: la plantilla
 * solo itera, y `{{...}}` escapa el HTML de cada campo (nombres de flujo
 * incluidos, que los escribe un operador).
 */
export const TELEMETRY_REPORT_TEMPLATE = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Informe de telemetría de IA</title>
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
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th { background: ${BRAND_SURFACE}; color: ${BRAND_TEXT_MUTED}; text-align: left; font-weight: 600; font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.04em; }
  th, td { padding: 5px 6px; border-bottom: 1px solid ${BRAND_BORDER}; vertical-align: top; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  td.mono { font-family: ${MONO_FONT_STACK}; font-size: 8.5px; }
  tfoot td { font-weight: 700; background: ${BRAND_SURFACE}; }
  .estimated { color: ${BRAND_WARNING}; font-weight: 600; }
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
    <h1>Informe de consumo de IA</h1>
    <p>Periodo: {{rangeLabel}} · Emitido el {{issuedAt}}</p>
    {{#if filtersLabel}}<p>Filtros: {{filtersLabel}}</p>{{/if}}
  </header>

  <section class="kpis">
    {{#each kpis}}
    <div class="kpi"><div class="label">{{label}}</div><div class="value">{{value}}</div></div>
    {{/each}}
  </section>

  <h2>Desglose por modelo</h2>
  {{#if breakdown.length}}
  <table>
    <thead>
      <tr>
        <th>Proveedor</th><th>Modelo</th><th class="num">Invocaciones</th>
        <th class="num">Tokens totales</th><th class="num">Fallidas</th><th class="num">Éxito</th>
        <th class="num">Coste (USD)</th>
      </tr>
    </thead>
    <tbody>
      {{#each breakdown}}
      <tr>
        <td>{{aiProvider}}</td><td class="mono">{{aiModel}}</td><td class="num">{{invocations}}</td>
        <td class="num">{{totalTokens}}</td><td class="num">{{failed}}</td><td class="num">{{successRate}}</td>
        <td class="num">{{costUsd}}</td>
      </tr>
      {{/each}}
    </tbody>
    <tfoot>
      <tr><td colspan="6">Total</td><td class="num">{{totalCostUsd}}</td></tr>
    </tfoot>
  </table>
  {{else}}
  <p class="empty">No hay consumo de IA registrado en el periodo.</p>
  {{/if}}

  <h2>Detalle de consumos</h2>
  {{#if items.length}}
  <table>
    <thead>
      <tr>
        <th>Fecha</th><th>Flujo</th><th>Nodo</th><th>Modelo</th><th>Usuario</th><th>Estado</th>
        <th class="num">Prompt</th><th class="num">Completación</th><th class="num">Razonamiento</th>
        <th class="num">Coste (USD)</th>
      </tr>
    </thead>
    <tbody>
      {{#each items}}
      <tr>
        <td>{{createdAt}}</td><td>{{flowName}}</td><td class="mono">{{nodeId}}</td><td class="mono">{{aiModel}}</td>
        <td>{{userEmail}}</td><td>{{status}}</td>
        <td class="num">{{promptTokens}}</td><td class="num">{{completionTokens}}</td><td class="num">{{reasoningTokens}}</td>
        <td class="num">{{#if isEstimated}}<span class="estimated" title="Coste aproximado">≈ </span>{{/if}}{{estimatedCostUsd}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>
  {{#if truncatedNote}}<p class="note">{{truncatedNote}}</p>{{/if}}
  <p class="note">≈ Coste aproximado: el proveedor no informó del uso o el modelo no tenía tarifa propia y se aplicó la genérica.</p>
  {{else}}
  <p class="empty">No hay inferencias registradas en el periodo.</p>
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
