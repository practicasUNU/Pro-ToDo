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
 * Rechazo de `flow:subscribe`. Viaja como `reason` del acuse, no como error de
 * handshake: la conexion sigue viva y solo se deniega ESA sala.
 *
 * Es el mismo valor tanto si el flujo no existe como si el socket no esta
 * autenticado, a proposito: distinguirlos convertiria el gateway en un oraculo
 * para averiguar que UUID de flujo son reales.
 */
export const FORBIDDEN_ROOM = 'FORBIDDEN_ROOM';

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

/**
 * Rechazo por origen no autorizado en la negociacion CORS del handshake.
 *
 * Viaja como `Error.message` hacia el adaptador, que lo traduce en la ausencia
 * de la cabecera `Access-Control-Allow-Origin`; el navegador corta entonces la
 * peticion por su cuenta.
 */
export const CORS_ORIGIN_DENIED = 'CORS_ORIGIN_DENIED';

/**
 * Origenes de desarrollo admitidos ademas de `FRONTEND_URL`.
 *
 * Estan codificados para que el canal funcione en una maquina recien clonada,
 * donde `backend/.env` todavia no existe. Es el UNICO punto donde acotar la
 * lista si algun dia molesta que tambien se admitan en produccion.
 */
const DEVELOPMENT_ORIGINS = ['http://localhost:9000', 'http://127.0.0.1:9000'];

/**
 * Decide si un origen puede abrir el canal de eventos.
 *
 * Vive aqui, y no incrustada en el decorador, por dos motivos. El primero es
 * que una funcion dentro de un decorador no es alcanzable desde un spec. El
 * segundo es el que causaba el fallo: un decorador se evalua AL IMPORTAR la
 * clase, antes de que `ConfigModule` cargue el `.env`, de modo que leer
 * `process.env.FRONTEND_URL` alli lo congelaba en `undefined` y el `|| '*'`
 * resultante es ilegal junto a `credentials: true`. Como callback, la lectura
 * ocurre en cada peticion, con el entorno ya cargado.
 */
export const resolveCorsOrigin = (
  requestOrigin: string | undefined,
  callback: (error: Error | null, allow?: boolean) => void,
): void => {
  const allowedOrigins = [process.env.FRONTEND_URL, ...DEVELOPMENT_ORIGINS].filter(
    (url): url is string => Boolean(url),
  );

  // Sin cabecera `Origin` no hay nada que proteger: son peticiones que no vienen
  // de una pagina (curl, sondas de salud, el mismo origen). La barrera real para
  // ellas es el middleware del handshake, que exige IP corporativa y JWT.
  if (requestOrigin === undefined || allowedOrigins.includes(requestOrigin)) {
    callback(null, true);

    return;
  }

  callback(new Error(CORS_ORIGIN_DENIED), false);
};
