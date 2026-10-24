/**
 * Tablas cuyas mutaciones se auditan. El valor es el nombre REAL de la tabla
 * (`@Entity(...)` de cada entidad): es lo que se guarda en
 * `audit_eventos.tabla_afectada` y lo que filtra la consulta.
 */
export enum AuditTable {
  USERS = 'usuarios',
  WORKFLOWS = 'flujos',
  HTML_TEMPLATES = 'plantillas_html',
  WORKFLOW_TEMPLATES = 'plantillas_flujo',
  AI_PROMPT_TEMPLATES = 'plantillas_prompts_ia',
  ALLOWED_IPS = 'allowed_ips',
  PRECIOS_MODELOS_IA = 'precios_modelos_ia',
}
