/**
 * Acciones humanas que registra `audit_eventos` (migracion 048).
 *
 * Los valores son los literales del CHECK de la columna `accion`: cambiarlos
 * aqui exige una migracion.
 *
 * ESTAN EN CASTELLANO a proposito, y son la excepcion declarada a la regla de
 * `code-conventions.md` §1. Esa regla gobierna los IDENTIFICADORES —las claves
 * del enum siguen en ingles— pero estos valores no son identificadores: son
 * DATO que se persiste y que un auditor lee en crudo cuando consulta la tabla
 * por SQL o abre el CSV exportado. Traducirlos solo en la capa de informes
 * dejaba el dato real en un idioma y su presentacion en otro.
 */
export enum AuditActionType {
  CREATE = 'CREAR',
  UPDATE = 'ACTUALIZAR',
  DELETE = 'ELIMINAR',
  /** UPDATE de `usuarios` que cambio el rol: se separa para poder filtrarlo. */
  ROLE_CHANGE = 'CAMBIO_ROL',
  LOGIN = 'INICIO_SESION',
  LOGIN_FAILED = 'INICIO_SESION_FALLIDO',
  /** Cierre de sesion explicito: cierra el par con `LOGIN` en la traza. */
  LOGOUT = 'CIERRE_SESION',
  /**
   * UPDATE que cambio la bandera de actividad del registro. Se separan de
   * `UPDATE` porque son las dos mutaciones que un auditor busca por si mismas:
   * «quien dejo sin acceso a esta cuenta» no se responde leyendo una lista de
   * modificaciones genericas.
   */
  ACTIVATE = 'ACTIVAR',
  DEACTIVATE = 'DESACTIVAR',
}
