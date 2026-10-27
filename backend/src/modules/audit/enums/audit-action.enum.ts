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
  /**
   * Un flujo PAUSADO por un fallo vuelve a quedar armado (CU-09), ya sea por
   * `POST /executions/:id/resume` o por un PATCH manual de `status`. Se separa
   * de `ACTIVATE` porque no es armar un flujo nuevo: es aceptar que el fallo
   * que lo detuvo quedo resuelto, y el auditor necesita saber QUIEN lo acepto.
   */
  RESUME = 'REANUDAR',
  /**
   * Cierre manual de una ejecucion detenida (CU-09): la ejecucion pasa a
   * DESCARTADO y su flujo queda INACTIVO. Se separa de `DEACTIVATE` porque no
   * es apagar un flujo sano: es renunciar a un trabajo pendiente, y el auditor
   * necesita su motivo y el estado del que venia.
   */
  FLOW_DISCARDED = 'FLUJO_DESCARTADO',
}
