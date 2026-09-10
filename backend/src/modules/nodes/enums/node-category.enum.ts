/**
 * Familia funcional de un tipo de nodo (tipo `enum_categoria` de PostgreSQL).
 *
 * Agrupa el catalogo en el selector del ensamblador: el operador razona en
 * "primero un disparador, luego procesamiento, al final un destino", no sobre
 * una lista plana de nueve entradas.
 *
 * Es ortogonal a `NodeType`: la categoria dice QUE PAPEL juega el nodo en el
 * grafo, y `NodeType` que ESTRATEGIA lo ejecuta.
 */
export enum NodeCategory {
  TRIGGER = 'TRIGGER',
  PROCESAMIENTO = 'PROCESAMIENTO',
  CONTROL = 'CONTROL',
  DESTINO = 'DESTINO',
}
