import {
  BRAND_BORDER,
  BRAND_CODE_SURFACE,
  BRAND_NEGATIVE,
  BRAND_PRIMARY,
  BRAND_PRIMARY_LIGHT,
  BRAND_SURFACE,
  BRAND_TEXT,
  BRAND_TEXT_MUTED,
  BRAND_WARNING,
  FONT_STACK,
  MONO_FONT_STACK,
} from '@common/constants/email-brand.constants';
import { escapeHtml } from '@common/utils/escape-html.util';

/**
 * Tope de caracteres del bloque de payload parcial.
 *
 * `partial_data` es lo que el nodo alcanzo a producir antes de fallar, y en el
 * caso que motiva el nodo —un parser que no pudo extraer texto— eso es el
 * payload entero del correo saneado. Volcarlo sin tope produciria una carta de
 * varios cientos de kilobytes que algunos proveedores rechazan y que ningun
 * cliente pinta de forma legible. Se recorta y se avisa del recorte: el volcado
 * COMPLETO ya vive en el checkpoint de PostgreSQL y en el `.log` del servidor,
 * que es donde se diagnostica de verdad.
 */
export const MAX_PAYLOAD_PREVIEW_LENGTH = 4_000;

/** Datos con los que se compone la carta de incidencia. */
export interface AlertEmailParams {
  /** Identificador del flujo. Sale de `context.getWorkflowId()`. */
  readonly flowId: string;
  /** Marca ISO-8601 del envio. */
  readonly timestamp: string;
  readonly failedNodeId?: string;
  readonly failedNodeType?: string;
  readonly errorCode?: string;
  readonly errorLevel?: string;
  readonly errorMessage?: string;
  /**
   * Causa raiz tecnica, mas larga que `errorMessage`.
   *
   * Sale de `NodeErrorDetail.description`: el mensaje es el titular que cabe en
   * el asunto, y esto el parrafo que dice contra que modelo o que portal se
   * intento y con que error respondio.
   */
  readonly errorDescription?: string;
  /**
   * Intentos reales consumidos y tope declarado por el nodo.
   *
   * Cambian lo que hace quien lee el correo: "fallo una vez" invita a reintentar
   * a mano; "fallo tras agotar tres" dice que el problema esta en el otro
   * extremo y que insistir no va a servir.
   */
  readonly attempts?: number;
  readonly maxRetries?: number;
  /** Nota en texto plano que el operador configuro en el nodo. */
  readonly customNote?: string;
  readonly partialData?: Record<string, unknown>;
  /**
   * Variable del asunto que no resolvio contra el contexto.
   *
   * Viaja hasta la carta a proposito. El aviso se envia igualmente con un asunto
   * de respaldo —perderlo por una errata seria el fallo mas caro de este nodo—,
   * pero entonces la misconfiguracion no dejaria rastro en ningun sitio que una
   * persona mire. Impresa al pie, llega a quien ya esta leyendo el correo.
   */
  readonly unresolvedSubjectVariable?: string;
}

/** Color del badge segun la severidad declarada por el motor. */
const severityColor = (level?: string): string => {
  if (level === 'URGENTE') return BRAND_NEGATIVE;

  return level === 'GRAVE' ? BRAND_WARNING : BRAND_TEXT_MUTED;
};

/** Serializa el payload parcial, recortandolo si excede el tope. */
const formatPayload = (payload: Record<string, unknown>): string => {
  const serialized = JSON.stringify(payload, null, 2);

  if (serialized.length <= MAX_PAYLOAD_PREVIEW_LENGTH) {
    return serialized;
  }

  return `${serialized.slice(0, MAX_PAYLOAD_PREVIEW_LENGTH)}\n\n[...] Recortado. El volcado completo esta en la trazabilidad de la ejecucion.`;
};

/** Fila de la tabla de diagnostico. Se omite entera si el dato no viene. */
const diagnosticRow = (label: string, value?: string): string => {
  if (value === undefined || value.trim().length === 0) {
    return '';
  }

  return `
        <tr>
          <td style="padding:6px 0;font-size:13px;line-height:20px;color:${BRAND_TEXT_MUTED};white-space:nowrap">${escapeHtml(label)}</td>
          <td style="padding:6px 0 6px 16px;font-size:13px;line-height:20px;color:${BRAND_TEXT};font-family:${MONO_FONT_STACK};word-break:break-all">${escapeHtml(value)}</td>
        </tr>`;
};

/**
 * Compone la carta institucional de incidencia.
 *
 * Maquetacion con TABLAS y CSS EN LINEA, igual que la del codigo de acceso y por
 * el mismo motivo: Gmail y Outlook descartan las hojas externas y el `<style>`
 * del `<head>`, y su soporte de flex y grid es irregular.
 *
 * TODO dato dinamico pasa por `escapeHtml`, sin excepcion. Varios de ellos
 * derivan del correo ENTRANTE —el `error_message` del parser cita el asunto del
 * mensaje, y `partial_data` lleva los nombres de los adjuntos—, asi que son
 * texto que escribe cualquiera que sepa la direccion del buzon del flujo.
 *
 * TODOS los campos salvo `flowId` y `timestamp` son opcionales, y su ausencia
 * OMITE la fila en vez de pintarla vacia. El nodo `DESTINO_SMTP` no esta atado a
 * la rama de error: puede colocarse en el camino feliz para confirmar una
 * publicacion, y ahi el namespace `error_context` sencillamente no existe. Una
 * plantilla que diera por hecho el desvio escribiria `undefined` en el correo
 * que lee una persona.
 */
export const buildAlertEmailHtml = (params: AlertEmailParams): string => {
  const {
    flowId,
    timestamp,
    failedNodeId,
    failedNodeType,
    errorCode,
    errorLevel,
    errorMessage,
    errorDescription,
    attempts,
    maxRetries,
    customNote,
    partialData,
    unresolvedSubjectVariable,
  } = params;

  const badge =
    errorLevel === undefined || errorLevel.trim().length === 0
      ? ''
      : `
            <span style="display:inline-block;background:${severityColor(errorLevel)};color:#FFFFFF;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;border-radius:999px;padding:4px 12px">${escapeHtml(errorLevel)}</span>`;

  // El nodo se nombra solo si se sabe cual fue. Sin `error_context` la frase
  // habla del flujo a secas, que es lo unico cierto en ese escenario.
  const headline =
    failedNodeId === undefined || failedNodeId.trim().length === 0
      ? `El flujo de automatizacion <strong style="color:${BRAND_TEXT}">${escapeHtml(flowId)}</strong> ha emitido una notificacion.`
      : `El flujo de automatizacion <strong style="color:${BRAND_TEXT}">${escapeHtml(flowId)}</strong> ha detenido su ejecucion en el nodo <strong style="color:${BRAND_TEXT}">${escapeHtml(failedNodeId)}</strong>.`;

  const noteBlock =
    customNote === undefined || customNote.trim().length === 0
      ? ''
      : `
        <tr>
          <td style="padding:0 28px 20px">
            <div style="background:${BRAND_SURFACE};border-left:3px solid ${BRAND_PRIMARY};border-radius:8px;padding:14px 18px">
              <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${BRAND_TEXT_MUTED};margin-bottom:6px">Nota del operador</div>
              <p style="margin:0;font-size:14px;line-height:22px;color:${BRAND_TEXT};white-space:pre-wrap">${escapeHtml(customNote)}</p>
            </div>
          </td>
        </tr>`;

  const messageBlock =
    errorMessage === undefined || errorMessage.trim().length === 0
      ? ''
      : `
        <tr>
          <td style="padding:0 28px 16px">
            <p style="margin:0;font-size:14px;line-height:22px;color:${BRAND_TEXT_MUTED}">${escapeHtml(errorMessage)}</p>
          </td>
        </tr>`;

  // "N de M" solo si se conocen los dos; con `attempts` a secas se imprime el
  // numero suelto, que sigue diciendo mas que nada. La fila entera desaparece
  // cuando no hay intentos que contar, igual que las demas de diagnostico.
  const retriesSummary =
    attempts === undefined
      ? undefined
      : maxRetries === undefined
        ? `${attempts}`
        : `${attempts} de ${maxRetries}`;

  const diagnosticRows = [
    diagnosticRow('Codigo de error', errorCode),
    diagnosticRow('Nivel', errorLevel),
    diagnosticRow('Tipo de nodo', failedNodeType),
    diagnosticRow('Reintentos ejecutados', retriesSummary),
    diagnosticRow('Flujo', flowId),
    diagnosticRow('Fecha / hora (UTC)', timestamp),
  ].join('');

  // Se imprime bajo el mensaje y no como fila de la tabla: es un parrafo, y
  // meterlo en una celda de diagnostico lo dejaria ilegible.
  const descriptionBlock =
    errorDescription === undefined || errorDescription.trim().length === 0
      ? ''
      : `
        <tr>
          <td style="padding:0 28px 16px">
            <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${BRAND_TEXT_MUTED};margin-bottom:6px">Causa raiz</div>
            <p style="margin:0;font-size:13px;line-height:20px;color:${BRAND_TEXT_MUTED}">${escapeHtml(errorDescription)}</p>
            ${
              attempts === undefined
                ? ''
                : `<p style="margin:8px 0 0;font-size:12px;line-height:18px;color:${BRAND_TEXT_MUTED}">Este aviso se emite una sola vez, despues de agotar formalmente la politica de reintentos del nodo.</p>`
            }
          </td>
        </tr>`;

  const payloadBlock =
    partialData === undefined || Object.keys(partialData).length === 0
      ? ''
      : `
        <tr>
          <td style="padding:0 28px 24px">
            <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${BRAND_TEXT_MUTED};margin-bottom:8px">Datos parciales del nodo</div>
            <pre style="margin:0;background:${BRAND_CODE_SURFACE};color:#FFFFFF;border-radius:8px;padding:16px;font-family:${MONO_FONT_STACK};font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;overflow:auto">${escapeHtml(formatPayload(partialData))}</pre>
          </td>
        </tr>`;

  const subjectWarning =
    unresolvedSubjectVariable === undefined
      ? ''
      : `
            <p style="margin:0 0 8px;font-size:11px;line-height:16px;color:${BRAND_NEGATIVE}">
              El asunto configurado para este nodo cita la variable <strong>${escapeHtml(unresolvedSubjectVariable)}</strong>, que no existe en el contexto del flujo. Se ha enviado con el asunto por defecto: corrigelo en la configuracion del nodo.
            </p>`;

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND_SURFACE};padding:32px 16px;font-family:${FONT_STACK}">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid ${BRAND_BORDER};border-radius:8px;overflow:hidden">
        <tr>
          <td style="background:linear-gradient(90deg, ${BRAND_PRIMARY} 0%, ${BRAND_PRIMARY_LIGHT} 100%);background-color:${BRAND_PRIMARY};padding:20px 28px">
            <span style="color:#FFFFFF;font-size:15px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase">Proto-Do &middot; Notificacion de Incidencia</span>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 28px 8px">${badge}
            <h1 style="margin:${badge === '' ? '0' : '14px'} 0 8px;font-size:20px;line-height:28px;font-weight:700;color:${BRAND_TEXT}">Flujo detenido</h1>
            <p style="margin:0;font-size:14px;line-height:22px;color:${BRAND_TEXT_MUTED}">${headline}</p>
          </td>
        </tr>${messageBlock}${descriptionBlock}${noteBlock}
        <tr>
          <td style="padding:0 28px 20px">
            <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${BRAND_TEXT_MUTED};margin-bottom:4px">Diagnostico tecnico</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${BRAND_BORDER}">${diagnosticRows}
            </table>
          </td>
        </tr>${payloadBlock}
        <tr>
          <td style="border-top:1px solid ${BRAND_BORDER};padding:16px 28px">${subjectWarning}
            <p style="margin:0;font-size:11px;line-height:16px;color:${BRAND_TEXT_MUTED}">
              Mensaje automatico de Proto-Do. No respondas a este correo: consulta la trazabilidad del flujo para reanudar o corregir la ejecucion.
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`.trim();
};

/**
 * Version en texto plano de la MISMA carta.
 *
 * Viaja siempre junto al HTML como parte alternativa del multipart, y vive en
 * este modulo y no en la estrategia para que las dos versiones no puedan
 * divergir: quien anada un dato a una lo tiene delante al escribir la otra.
 *
 * No es una cortesia con clientes antiguos. Es lo que hace legible el aviso en
 * un reloj, en una notificacion del movil y en un cliente con las imagenes y el
 * marcado bloqueados —que es una configuracion corriente en correo corporativo.
 * Aqui NO se escapa nada: el texto plano no interpreta marcado.
 */
export const buildAlertEmailText = (params: AlertEmailParams): string => {
  const lines: string[] = ['PROTO-DO - NOTIFICACION DE INCIDENCIA', ''];

  lines.push(
    params.failedNodeId === undefined || params.failedNodeId.trim().length === 0
      ? `El flujo ${params.flowId} ha emitido una notificacion.`
      : `El flujo ${params.flowId} ha detenido su ejecucion en el nodo ${params.failedNodeId}.`,
  );

  if (
    params.errorMessage !== undefined &&
    params.errorMessage.trim().length > 0
  ) {
    lines.push('', params.errorMessage);
  }

  if (
    params.errorDescription !== undefined &&
    params.errorDescription.trim().length > 0
  ) {
    lines.push('', 'CAUSA RAIZ', params.errorDescription);

    if (params.attempts !== undefined) {
      lines.push(
        'Este aviso se emite una sola vez, despues de agotar formalmente la politica de reintentos del nodo.',
      );
    }
  }

  if (params.customNote !== undefined && params.customNote.trim().length > 0) {
    lines.push('', 'NOTA DEL OPERADOR', params.customNote);
  }

  lines.push('', 'DIAGNOSTICO TECNICO');

  const diagnostics: ReadonlyArray<readonly [string, string | undefined]> = [
    ['Codigo de error', params.errorCode],
    ['Nivel', params.errorLevel],
    ['Tipo de nodo', params.failedNodeType],
    [
      'Reintentos ejecutados',
      params.attempts === undefined
        ? undefined
        : params.maxRetries === undefined
          ? `${params.attempts}`
          : `${params.attempts} de ${params.maxRetries}`,
    ],
    ['Flujo', params.flowId],
    ['Fecha / hora (UTC)', params.timestamp],
  ];

  for (const [label, value] of diagnostics) {
    if (value !== undefined && value.trim().length > 0) {
      lines.push(`- ${label}: ${value}`);
    }
  }

  if (
    params.partialData !== undefined &&
    Object.keys(params.partialData).length > 0
  ) {
    lines.push(
      '',
      'DATOS PARCIALES DEL NODO',
      formatPayload(params.partialData),
    );
  }

  if (params.unresolvedSubjectVariable !== undefined) {
    lines.push(
      '',
      `AVISO: el asunto configurado cita la variable ${params.unresolvedSubjectVariable}, que no existe en el contexto. Se ha enviado con el asunto por defecto.`,
    );
  }

  lines.push(
    '',
    'Mensaje automatico de Proto-Do. No respondas a este correo: consulta la trazabilidad del flujo para reanudar o corregir la ejecucion.',
  );

  return lines.join('\n');
};
