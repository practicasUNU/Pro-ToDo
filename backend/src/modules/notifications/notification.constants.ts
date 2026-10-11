/**
 * Motivos de rechazo del handshake. Son el CONTRATO DE CABLE con el cliente:
 * viajan como `Error.message` del `connect_error` de Socket.io, y
 * `frontend/src/boot/socket.ts` los compara literalmente para decidir si purga
 * la sesion o si simplemente deja reintentar al reconector.
 *
 * Deliberadamente genericos: el cliente necesita distinguir "tu credencial no
 * vale" de "el servidor esta caido", y nada mas. Detallar si fallo la firma, si
 * caduco o si la IP esta fuera de rango solo ayudaria a quien sondea desde
 * fuera del perimetro.
 */
export const WS_DENIED_ORIGIN = 'WS_DENIED_ORIGIN';
export const WS_INVALID_TOKEN = 'WS_INVALID_TOKEN';

/**
 * Salas de flujo que un solo socket puede ocupar a la vez.
 *
 * No es una cifra de capacidad sino un tope de abuso: un socket ya autenticado
 * puede pedir `flow:subscribe` tantas veces como quiera, y sin techo el mapa de
 * salas del adaptador crece hasta donde aguante la memoria del proceso. Cincuenta
 * sobra para cualquier panel real, que mira un flujo o una lista corta.
 */
export const MAX_ROOMS_PER_SOCKET = 50;

/** Prefijo de las salas por flujo. */
export const FLOW_ROOM_PREFIX = 'flow_';

/** Prefijo de la sala privada de cada usuario autenticado. */
export const USER_ROOM_PREFIX = 'user_';
