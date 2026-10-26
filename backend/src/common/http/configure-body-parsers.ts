import { json } from 'express';

import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Ruta del banco de pruebas y su tope de cuerpo JSON.
 *
 * El parser global acepta 100 KB, y una prueba de PROCESADOR_OCR lleva el
 * adjunto en base64 dentro del contexto simulado: un PDF de 5 MB ocupa casi
 * 7 MB codificado. Se amplia SOLO esta ruta, que exige JWT, rol y red interna;
 * subir el limite global ensancharia la superficie de denegacion de servicio
 * de toda la API por una necesidad de un unico endpoint.
 */
export const SANDBOX_RUN_PATH = '/api/nodes/sandbox/run';
export const SANDBOX_JSON_LIMIT = '10mb';

/**
 * Monta los parsers de cuerpo de la API. Exige crear la app con
 * `{ bodyParser: false }`.
 *
 * POR QUE NO SE DEJA A NEST. Nest decide si monta su parser JSON buscando en la
 * pila de Express una capa cuya funcion se llame `jsonParser`, que es justo el
 * nombre del `json()` de Express. Montar el parser ampliado del banco de
 * pruebas con el arranque por defecto le hacia creer que el global ya existia:
 * todas las demas rutas se quedaban sin cuerpo y el login respondia 400 con
 * `email` indefinido. Registrandolos aqui, el orden y la existencia de cada
 * parser son explicitos.
 *
 * ORDEN. El ampliado va primero; en esa ruta el global ve el cuerpo ya leido y
 * lo salta (body-parser comprueba `onFinished.isFinished(req)`).
 */
export const configureBodyParsers = (app: NestExpressApplication): void => {
  app.use(SANDBOX_RUN_PATH, json({ limit: SANDBOX_JSON_LIMIT }));
  app.useBodyParser('json');
  app.useBodyParser('urlencoded', { extended: true });
};
