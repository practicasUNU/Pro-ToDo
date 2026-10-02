/**
 * Marcado institucional real de Madrid+D que provocaba un 400 al guardarse.
 *
 * Procede de un correo de Licitacion compuesto en Drupal y copiado desde
 * Outlook, de ahi la mezcla que rechazaba la lista blanca anterior: `<u>` en el
 * plazo, `title` en la imagen, `data-olk-copy-source` que inyecta el cliente de
 * correo, `id` en el contenedor y maquetacion en linea (`border`,
 * `vertical-align`, `font-size`, `line-height`).
 *
 * Incluye ademas el marcador `{{raw_email.from}}` en texto y como valor INTEGRO
 * de un `href`, que es el otro falso positivo que el auditor debia dejar pasar.
 */
export const MADRID_D_TEMPLATE_HTML = `
<div id="licitacion-panel" class="panel-body" style="font-size:14px;line-height:1.5">
  <h2 style="color:#12142E">Licitacion de servicios de innovacion</h2>
  <p>
    <img src="/modules/custom/mdrd/images/logo.png" alt="Madrid+D"
         title="Fundacion para el Conocimiento Madrimasd"
         width="120" height="40" style="border:0;vertical-align:middle" />
  </p>
  <p>Plazo de presentacion: <u>Hasta el dia 8 de octubre de 2026</u></p>
  <table style="width:100%">
    <tbody>
      <tr>
        <th style="text-align:left">Expediente</th>
        <td style="vertical-align:top">2026/INN/0042</td>
      </tr>
    </tbody>
  </table>
  <span data-olk-copy-source="MessageBody" class="meta">
    Remitido por {{raw_email.from}}
  </span>
  <p><a href="{{raw_email.from}}" target="_blank" title="Contacto">Escribir al remitente</a></p>
</div>
`;
